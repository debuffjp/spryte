// The simulation, in a worker so the page only projects and draws. It keeps its own clock, steps the
// tracers and storms, and posts a snapshot of every tracer about 60 times a second. Snapshot buffers are
// transferred, not copied, and come back from the page to be reused.
import { anticyclone, belt, CAP, cosOf, EDDIES, inside, LAT_MAX, RADIUS_KM, rowOf, type Snapshot, type Storm, wind } from "./planet.ts";

const KM_PER_DEG = (RADIUS_KM * Math.PI) / 180;
const M_PER_DEG = KM_PER_DEG * 1000;
const DEG_PER_M = 1 / M_PER_DEG;
const BINS = 2 * LAT_MAX;

// Short-lived eddies keep the band edges churning: cyclones in the belts, anticyclones in the zones.
// Their sizes, speeds and lifetimes are guesses chosen to look like the weather, not measurements.
function eddy(): Storm {
  const y = (Math.random() * 2 - 1) * 50;
  const spin = anticyclone(y);
  return {
    lon: Math.random() * 360 - 180,
    lat: y,
    a: 1200 + Math.random() * 2000,
    b: 800 + Math.random() * 1000,
    vmax: 25 + Math.random() * 30,
    spin: belt[rowOf(y)] ? (-spin as 1 | -1) : spin,
    life: (4 + Math.random() * 10) * 86_400,
    age: 0,
    eddy: true,
  };
}
// The Great Red Spot: about 16,000 km across (Parisi et al. 2021, from Juno). Its north-south size and
// wind speed here are rough round numbers, as is everything about Oval BA.
const storms: Storm[] = [
  { name: "Great Red Spot", lon: 0, lat: -22, a: 8000, b: 5000, vmax: 120, spin: 1, life: Infinity, age: 86_400 },
  { name: "Oval BA", lon: 70, lat: -33.5, a: 3500, b: 2500, vmax: 90, spin: 1, life: Infinity, age: 86_400 },
];
// A few white ovals in the zones, where anticyclones live. The table only lists the eastward jets
// poleward of 32°S and 43°N, so keep them nearer the equator, where both kinds of jet are measured.
for (let k = 0; k < 6; k++) {
  let y = 0;
  do y = Math.random() * 70 - 35;
  while (belt[rowOf(y)] || Math.abs(y) < 9);
  storms.push({
    lon: Math.random() * 360 - 180,
    lat: y,
    a: 1800 + Math.random() * 1200,
    b: 1300 + Math.random() * 600,
    vmax: 50,
    spin: anticyclone(y),
    life: Infinity,
    age: 86_400,
  });
}

const lon = new Float32Array(CAP);
const lat = new Float32Array(CAP);
const colors = new Uint32Array(CAP);
const BELT = [0x8a5a3cff, 0xa8714cff, 0x6f4a35ff];
const ZONE = [0xe9dcc0ff, 0xd8c7a6ff, 0xf2e8d4ff];
const POLE = 0x7d8a96ff;
const RED = 0xc8553dff;
const WHITE = 0xfaf6eeff;
// A little turbulence, so the streaks don't stay perfectly straight: north-south nudges in m/s, read
// from a table at a different offset each step instead of a Math.random() call per tracer.
const NOISE = new Float32Array(1 << 16);
for (let k = 0; k < NOISE.length; k++) NOISE[k] = (Math.random() - 0.5) * 6;
let noiseAt = 0;

function mix(a: number, b: number, t: number): number {
  const ch = (s: number): number => Math.round(((a >>> s) & 255) * (1 - t) + ((b >>> s) & 255) * t);
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | 0xff) >>> 0;
}
function scatter(from: number, to: number): void {
  for (let i = from; i < to; i++) {
    lon[i] = Math.random() * 360 - 180;
    // Even coverage on the sphere: fewer tracers where the latitude circles are short.
    lat[i] = (Math.asin((Math.random() * 2 - 1) * Math.sin((LAT_MAX * Math.PI) / 180)) * 180) / Math.PI;
    const shade = (Math.random() * 3) | 0;
    const base = belt[rowOf(lat[i])] ? BELT[shade] : ZONE[shade];
    // Toward the poles the bands give way to a grey-blue haze.
    const pole = Math.max(0, Math.min(1, (Math.abs(lat[i]) - 45) / 35));
    colors[i] = mix(base, POLE, pole * 0.6);
    for (const s of storms) if (!s.eddy && inside(s, lon[i], lat[i], 0.8)) colors[i] = s.name ? RED : WHITE;
  }
}

// Per storm, the numbers every tracer near it needs, rebuilt each step, and each 1° band's storms.
let sLon = new Float32Array(0);
let sLat = new Float32Array(0);
let invA2 = new Float32Array(0);
let invB2 = new Float32Array(0);
let psi = new Float32Array(0);
let fade = new Float32Array(0);
let carry = new Float32Array(0);
const bins: number[][] = Array.from({ length: BINS }, () => []);
let vx = 0;
let vy = 0;
let stirred = false; // whether any storm touched the last velocity()

/** The wind at a longitude and latitude, into vx and vy: the band's jet, plus every storm near enough. */
function velocity(x: number, y: number): void {
  const r = rowOf(y);
  const cos = cosOf[r];
  let u = wind[r];
  let v = 0;
  stirred = false;
  const near = bins[Math.min(BINS - 1, Math.max(0, Math.floor(y + LAT_MAX)))];
  for (let t = 0; t < near.length; t++) {
    const k = near[t];
    let dl = x - sLon[k];
    if (dl > 180) dl -= 360;
    else if (dl < -180) dl += 360;
    const ex = dl * M_PER_DEG * cos;
    const ey = (y - sLat[k]) * M_PER_DEG;
    const q = ex * ex * invA2[k] + ey * ey * invB2[k];
    if (q > 9) continue;
    const g = Math.exp(-q) * fade[k];
    stirred = true;
    // Inside the storm the band's own wind is mostly replaced by the storm's: a vortex carries its
    // core along with it, so tracers caught inside go round instead of streaming through.
    u = u * (1 - 0.85 * g) + carry[k] * 0.85 * g;
    u += psi[k] * 2 * ey * invB2[k] * g;
    v -= psi[k] * 2 * ex * invA2[k] * g;
  }
  vx = u;
  vy = v;
}

/** Moves every tracer and storm forward by `dt` simulated seconds. */
function step(dt: number): void {
  for (const s of storms) {
    s.lon += (wind[rowOf(s.lat)] * dt * DEG_PER_M) / Math.cos((s.lat * Math.PI) / 180);
    if (s.lon > 180) s.lon -= 360;
    s.life -= dt;
    s.age += dt;
  }
  for (let k = storms.length - 1; k >= 0; k--) if (storms[k].life <= 0) storms.splice(k, 1);
  let eddies = 0;
  for (const s of storms) if (s.eddy) eddies++;
  for (; eddies < EDDIES; eddies++) storms.push(eddy());

  // psi is the streamfunction peak, so the storm's wind tops out at vmax: psi = vmax * b * sqrt(e / 2).
  // Storms grow in over their first day and fade over their last few.
  const m = storms.length;
  if (sLon.length < m) {
    sLon = new Float32Array(m * 2);
    sLat = new Float32Array(m * 2);
    invA2 = new Float32Array(m * 2);
    invB2 = new Float32Array(m * 2);
    psi = new Float32Array(m * 2);
    fade = new Float32Array(m * 2);
    carry = new Float32Array(m * 2);
  }
  for (const b of bins) b.length = 0;
  for (let k = 0; k < m; k++) {
    const s = storms[k];
    sLon[k] = s.lon;
    sLat[k] = s.lat;
    invA2[k] = 1 / (s.a * 1000) ** 2;
    invB2[k] = 1 / (s.b * 1000) ** 2;
    psi[k] = -s.spin * s.vmax * s.b * 1000 * Math.sqrt(Math.E / 2);
    fade[k] = Math.min(1, s.life / (3 * 86_400), s.age / 86_400);
    carry[k] = wind[rowOf(s.lat)];
    // File the storm under every 1° band its reach touches, so a tracer only checks its own band's.
    const reach = (3 * s.b) / KM_PER_DEG;
    const lo = Math.max(0, Math.floor(s.lat - reach + LAT_MAX));
    const hi = Math.min(BINS - 1, Math.floor(s.lat + reach + LAT_MAX));
    for (let b = lo; b <= hi; b++) bins[b].push(k);
  }

  const half = 0.5 * dt * DEG_PER_M;
  const full = dt * DEG_PER_M;
  noiseAt = (noiseAt + 7919) & (NOISE.length - 1);
  for (let i = 0; i < n; i++) {
    // Midpoint steps near storms: plain Euler steps spiral tracers outward round a vortex and empty its
    // core. Away from them the wind depends only on latitude, so one plain step is already exact.
    const x0 = lon[i];
    const y0 = lat[i];
    velocity(x0, y0);
    if (stirred) velocity(x0 + (vx * half) / cosOf[rowOf(y0)], y0 + vy * half);
    const y = y0 + (vy + NOISE[(i + noiseAt) & (NOISE.length - 1)]) * full;
    let x = x0 + (vx * full) / cosOf[rowOf(0.5 * (y0 + y))];
    if (x > 180) x -= 360;
    else if (x < -180) x += 360;
    lon[i] = x;
    lat[i] = y;
    if (Math.abs(y) > LAT_MAX) scatter(i, i + 1);
  }
}

let n = 0;
let speed = 6 * 3600; // simulated seconds per second
let paused = false;
let days = 0;
// Simulated seconds still to run as fast as the worker can: the opening weeks, so the eddies are
// already churning when the page appears, and any month the Skip button adds.
let catchUp = 21 * 86_400;
let last = performance.now();
let stepMs = 0;
let owed = 0; // simulated seconds the clock has asked for that the steps haven't run yet
let rate = 0;
const pool: Snapshot[] = [];

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.count !== undefined) {
    if (m.count > n) scatter(n, m.count);
    n = m.count;
  }
  if (m.speed) {
    speed = m.speed;
    owed = 0;
  }
  if (m.paused !== undefined) paused = m.paused;
  if (m.skip) catchUp += m.skip;
  if (m.storm) {
    const { lon: x, lat: y } = m.storm;
    // A click's convective storm: a white anticyclone that lives a few weeks, then fades.
    const s: Storm = { lon: x, lat: y, a: 2500, b: 1800, vmax: 70, spin: anticyclone(y), life: 30 * 86_400, age: 0 };
    storms.push(s);
    for (let i = 0; i < n; i++) if (inside(s, lon[i], lat[i], 1)) colors[i] = WHITE;
  }
  if (m.recycle) pool.push(m.recycle);
};

function loop(): void {
  const t0 = performance.now();
  const dt = Math.min(0.1, (t0 - last) / 1000);
  last = t0;
  if (!paused && n > 0) {
    // Steps of at most two hours, so a tracer never crosses a large part of a storm in one go, for as
    // long as 24 ms allows. At the fastest speeds that isn't enough: the backlog is capped at a quarter
    // second of time, so the clock runs slower than asked rather than falling ever further behind.
    owed = Math.min(owed + dt * speed, speed * 0.25 + 7200);
    let ran = 0;
    while (owed > 0 && performance.now() - t0 < 24) {
      const s = Math.min(7200, owed);
      step(s);
      owed -= s;
      ran += s;
    }
    days += ran / 86_400;
    if (dt > 0) rate += (ran / dt - rate) * 0.05;
  } else rate = 0;
  // Catching up: whole two-hour steps for up to 30 ms, then a snapshot so the page sees progress.
  while (catchUp > 0 && n > 0 && performance.now() - t0 < 30) {
    const s = Math.min(7200, catchUp);
    step(s);
    catchUp -= s;
    days += s / 86_400;
  }
  const spent = performance.now() - t0;
  stepMs += (spent - stepMs) * 0.1;
  const snap = pool.pop();
  if (snap && n > 0) {
    if (snap.lon.length < n) {
      snap.lon = new Float32Array(CAP);
      snap.lat = new Float32Array(CAP);
      snap.colors = new Uint32Array(CAP);
    }
    snap.lon.set(lon.subarray(0, n));
    snap.lat.set(lat.subarray(0, n));
    snap.colors.set(colors.subarray(0, n));
    snap.n = n;
    snap.days = days;
    snap.catchingUp = catchUp > 0;
    snap.stepMs = stepMs;
    snap.rate = rate;
    snap.named = storms.filter((s) => s.name).map(({ lon, lat, a, b, name }) => ({ lon, lat, a, b, name }));
    self.postMessage(snap, { transfer: [snap.lon.buffer, snap.lat.buffer, snap.colors.buffer] });
  } else if (snap) pool.push(snap);
  setTimeout(loop, Math.max(0, 16 - spent));
}
// Three snapshots in flight at most: one being drawn, one on its way, one being filled.
for (let k = 0; k < 3; k++)
  pool.push({
    lon: new Float32Array(0),
    lat: new Float32Array(0),
    colors: new Uint32Array(0),
    n: 0,
    days: 0,
    catchingUp: false,
    stepMs: 0,
    rate: 0,
    named: [],
  });
loop();
