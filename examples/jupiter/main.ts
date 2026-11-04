// Jupiter's cloud bands and storms as a kinematic sketch: up to 300,000 cloud tracers ride the measured
// zonal jets, and storms (Gaussian vortices) spin inside the bands and drift with the jet at their
// latitude. Nothing here solves fluid equations: the jets are fixed from observation and the storms are
// imposed. The simulation runs in a worker (sim.ts); this page projects the latest snapshot onto the
// globe and draws every tracer as one copy in a single sprites() call.
import { createRenderer, type Draw } from "spryte";
import {
  belt,
  CAP,
  cosOf,
  EDDIES,
  FASTEST,
  FLAT,
  inside,
  LAT_MAX,
  LON_STEPS,
  PRESETS,
  ROW,
  ROWS,
  rowOf,
  SLOWEST,
  type Snapshot,
  sinLon,
  sinOf,
  span,
  wind,
} from "./planet.ts";

const pos = new Float32Array(CAP * 2);
const lit = new Uint32Array(CAP); // colours as drawn this frame, after shading

// The planet's dark body, drawn under the clouds on the globe.
const DISC = 256;
const disc = new OffscreenCanvas(DISC, DISC);
{
  const g = disc.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const fill = g.createRadialGradient(DISC / 2, DISC / 2, 0, DISC / 2, DISC / 2, DISC / 2);
  fill.addColorStop(0, "#4a3626");
  fill.addColorStop(0.9, "#241a12");
  fill.addColorStop(1, "#140f0a");
  g.fillStyle = fill;
  g.beginPath();
  g.arc(DISC / 2, DISC / 2, DISC / 2, 0, Math.PI * 2);
  g.fill();
}

// A small soft dot, made at runtime so the demo has no assets.
const dot = new OffscreenCanvas(6, 6);
{
  const g = dot.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const fill = g.createRadialGradient(3, 3, 0, 3, 3, 3);
  fill.addColorStop(0, "rgba(255,255,255,1)");
  fill.addColorStop(0.6, "rgba(255,255,255,0.8)");
  fill.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = fill;
  g.fillRect(0, 0, 6, 6);
}

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let n = innerWidth < 600 ? 60_000 : 200_000;
let speed = 6 * 3600; // simulated seconds per second
const sim = new Worker(new URL("./sim.ts", import.meta.url), { type: "module" });
// The newest snapshot from the worker; the one it replaces goes straight back to be refilled.
let snap: Snapshot | null = null;
sim.onmessage = (e: MessageEvent<Snapshot>) => {
  if (snap) sim.postMessage({ recycle: snap }, [snap.lon.buffer, snap.lat.buffer, snap.colors.buffer]);
  snap = e.data;
};
const pointer = { x: 0, y: 0, on: false };
// Visitors who ask for less motion get still clouds until they press Play.
let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;
function setPaused(p: boolean): void {
  paused = p;
  sim.postMessage({ paused: p });
  pauseButton.textContent = p ? "Play" : "Pause";
  pauseButton.setAttribute("aria-pressed", String(p));
}
pauseButton.addEventListener("click", () => setPaused(!paused));

const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
const probe = document.getElementById("probe") as HTMLDivElement;
let canvas = document.createElement("canvas");
stage.append(canvas);
let draw: Draw = createRenderer(canvas, { backend });

function press(groupId: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${groupId} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
document.getElementById("counts")?.addEventListener("click", (e) => {
  const c = Number((e.target as HTMLElement).dataset.count);
  if (!c) return;
  n = c;
  sim.postMessage({ count: c });
  press("counts", "count", String(c));
});
// Time: a slider on a log scale from a minute to a month per second, stops for the common speeds,
// buttons that jump ahead, and keys for all of it.
const rateSlider = document.getElementById("rate") as HTMLInputElement;
const rateLabel = document.getElementById("rate-label") as HTMLOutputElement;
const toSlider = (s: number): number => (1000 * Math.log(s / SLOWEST)) / Math.log(FASTEST / SLOWEST);
const fromSlider = (v: number): number => SLOWEST * (FASTEST / SLOWEST) ** (v / 1000);
function setSpeed(s: number): void {
  speed = Math.max(SLOWEST, Math.min(FASTEST, s));
  sim.postMessage({ speed });
  rateSlider.value = String(Math.round(toSlider(speed)));
  rateLabel.value = span(speed);
  press("presets", "speed", String(speed));
}
rateSlider.addEventListener("input", () => {
  // Snap to a stop when the slider passes close to one, so the labelled speeds are easy to land on.
  const v = Number(rateSlider.value);
  const near = PRESETS.find((p) => Math.abs(toSlider(p) - v) < 12);
  setSpeed(near ?? Math.round(fromSlider(v) / 60) * 60);
});
const presets = document.getElementById("presets") as HTMLFieldSetElement;
for (const p of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.speed = String(p);
  b.textContent = span(p);
  presets.append(b);
}
presets.addEventListener("click", (e) => {
  const s = Number((e.target as HTMLElement).dataset.speed);
  if (s) setSpeed(s);
});
document.getElementById("jumps")?.addEventListener("click", (e) => {
  const s = Number((e.target as HTMLElement).dataset.skip);
  if (s) sim.postMessage({ skip: s });
});
// Space pauses, [ and ] move down or up through the stops, comma and full stop jump an hour or a day.
addEventListener("keydown", (e) => {
  if (e.key === " ") {
    e.preventDefault();
    setPaused(!paused);
  } else if (e.key === "]") setSpeed(PRESETS.find((p) => p > speed * 1.01) ?? FASTEST);
  else if (e.key === "[") setSpeed([...PRESETS].reverse().find((p) => p < speed * 0.99) ?? SLOWEST);
  else if (e.key === ",") sim.postMessage({ skip: 3600 });
  else if (e.key === ".") sim.postMessage({ skip: 86_400 });
});
document.getElementById("backends")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).dataset.backend as "auto" | "2d" | undefined;
  if (!b || b === backend) return;
  backend = b;
  draw.dispose();
  // A canvas keeps the first context type it gets, so switching renderer means a new canvas.
  const fresh = document.createElement("canvas");
  canvas.replaceWith(fresh);
  canvas = fresh;
  draw = createRenderer(canvas, { backend });
  press("backends", "backend", b);
});

// The globe's orientation: the longitude facing the viewer and the tilt toward or away from us.
type View = "closeup" | "globe" | "map";
let view: View = "closeup";
let faceLon = 0;
let lonOffset = 0; // the facing longitude
let tilt = 0;
let flip = 1; // -1 turns the picture upside down, south at the top
// How each view frames the planet: radius as a fraction of the stage's shorter side, centre as a
// fraction of its width and height, the latitude and longitude facing us, and which way is up.
// The close-up copies a Juno photo of the Great Red Spot from above the south, with south at the top.
// Its longitude is measured from the Great Red Spot wherever that has drifted to; after that the camera
// is the viewer's to turn, pan and zoom.
const FRAMES = {
  closeup: { r: 1.35, x: 0.66, y: -0.5, lat: -76, lon: -24, flip: -1 },
  globe: { r: 0.46, x: 0.5, y: 0.5, lat: -20, lon: 0, flip: 1 },
} as const;
let cam = { x: 0.5, y: 0.5, r: 0.46 }; // the globe's centre and radius, as in FRAMES
let findSpot = false; // the close-up still has to face the Great Red Spot
function frameView(v: View): void {
  view = v;
  if (v === "map") return;
  const f = FRAMES[v];
  cam = { x: f.x, y: f.y, r: f.r };
  tilt = (f.lat * Math.PI) / 180;
  lonOffset = f.lon;
  flip = f.flip;
  findSpot = v === "closeup";
}
let globe = { cx: 0, cy: 0, r: 1 };
let tiltCos = 1; // cos and sin of the tilt, set once a frame
let tiltSin = 0;

/** The longitude and latitude under a screen point, or null off the planet. */
function fromScreen(x: number, y: number, w: number, h: number): [number, number] | null {
  if (view === "map") return [(x / w) * 360 - 180, LAT_MAX - (y / h) * 2 * LAT_MAX];
  const px = (flip * (x - globe.cx)) / globe.r;
  const py = (-flip * (y - globe.cy)) / (globe.r * FLAT);
  const pz2 = 1 - px * px - py * py;
  if (pz2 < 0) return null;
  const pz = Math.sqrt(pz2);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const cy = py * ct + pz * st;
  const cz = -py * st + pz * ct;
  let l = (Math.atan2(px, cz) * 180) / Math.PI + faceLon;
  if (l > 180) l -= 360;
  else if (l < -180) l += 360;
  return [l, (Math.asin(Math.max(-1, Math.min(1, cy))) * 180) / Math.PI];
}
document.getElementById("views")?.addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).dataset.view as View | undefined;
  if (!v) return;
  frameView(v);
  press("views", "view", v);
});

// Drag to turn the globe; drag with the right button or Shift held to move it. A click without a drag starts a convective storm: a white anticyclone that
// lives a few weeks, then fades.
let drag: { x: number; y: number; moved: number; pan: boolean } | null = null;
stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, moved: 0, pan: e.button !== 0 || e.shiftKey };
});
stage.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});
stage.addEventListener("pointerup", (e) => {
  const wasClick = drag !== null && drag.moved < 5;
  drag = null;
  if (!wasClick) return;
  const r = stage.getBoundingClientRect();
  const hit = fromScreen(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  if (!hit || Math.abs(hit[1]) > LAT_MAX - 3) return;
  sim.postMessage({ storm: { lon: hit[0], lat: hit[1] } });
});
stage.addEventListener("pointermove", (e) => {
  const r = stage.getBoundingClientRect();
  pointer.x = e.clientX - r.left;
  pointer.y = e.clientY - r.top;
  pointer.on = true;
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (view === "map") return;
  if (drag.pan) {
    cam.x += dx / r.width;
    cam.y += dy / r.height;
    return;
  }
  lonOffset -= (flip * dx * (180 / Math.PI)) / globe.r;
  tilt = Math.max(-1.5, Math.min(1.5, tilt + (flip * dy) / globe.r));
});
stage.addEventListener("pointerleave", () => {
  pointer.on = false;
});
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (view === "map") return;
    // Zoom about the pointer: the point under it stays put.
    const r = stage.getBoundingClientRect();
    const k = Math.max(0.15, Math.min(6, cam.r * Math.exp(-e.deltaY * 0.001))) / cam.r;
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    cam = { x: px - (px - cam.x) * k, y: py - (py - cam.y) * k, r: cam.r * k };
  },
  { passive: false },
);

let last = 0;
let fps = 60;
let projectMs = 0;
let drawMs = 0;
/** Simulated time as "day 31, 06:00". */
function clock(days: number): string {
  const minutes = Math.floor((days % 1) * 1440);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `day ${Math.floor(days)}, ${hh}:${mm}`;
}

function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    draw.resize(pw, ph);
  }
  const t0 = performance.now();
  if (!snap) {
    requestAnimationFrame(frame);
    return;
  }
  const { lon, lat, colors } = snap;
  let shown = snap.n;
  if (view === "map") {
    for (let i = 0; i < snap.n; i++) {
      pos[i * 2] = ((lon[i] + 180) / 360) * w;
      pos[i * 2 + 1] = ((LAT_MAX - lat[i]) / (2 * LAT_MAX)) * h;
      lit[i] = colors[i];
    }
  } else {
    if (findSpot) {
      lonOffset += snap.named[0].lon;
      findSpot = false;
    }
    faceLon = lonOffset - Math.floor((lonOffset + 180) / 360) * 360;
    globe = { cx: w * cam.x, cy: h * cam.y, r: Math.min(w, h / FLAT) * cam.r };
    tiltCos = Math.cos(tilt);
    tiltSin = Math.sin(tilt);
    shown = 0;
    // The globe projection, with everything per frame hoisted and trig from tables: this loop runs for
    // every tracer every frame.
    const { cx: gx, cy: gy } = globe;
    const rx = flip * globe.r;
    const ry = flip * globe.r * FLAT;
    const quarter = LON_STEPS / 4;
    for (let i = 0; i < snap.n; i++) {
      let d = lon[i] - faceLon;
      if (d < 0) d += 360;
      else if (d >= 360) d -= 360;
      const k = ((d / ROW + 0.5) | 0) % LON_STEPS;
      const r = rowOf(lat[i]);
      const cosLat = cosOf[r];
      const sy = sinOf[r];
      const sz = cosLat * sinLon[k + quarter];
      const mu = sy * tiltSin + sz * tiltCos;
      if (mu <= 0) continue;
      pos[shown * 2] = gx + rx * cosLat * sinLon[k];
      pos[shown * 2 + 1] = gy - ry * (sy * tiltCos - sz * tiltSin);
      // Limb darkening: clouds seen at a slant toward the edge look dimmer.
      const c = colors[i];
      const light = 0.2 + 0.8 * Math.sqrt(mu);
      lit[shown++] = ((((c >>> 24) * light) << 24) | ((((c >>> 16) & 255) * light) << 16) | ((((c >>> 8) & 255) * light) << 8) | 255) >>> 0;
    }
  }
  const t1 = performance.now();
  draw.begin("#11140d", w, h, dpr);
  if (view !== "map") {
    // Dots just big enough to close the gaps: more tracers, smaller dots. Bigger ones only overdraw,
    // and at 200,000 tracers overdraw, not the simulation, is what holds the frame rate back.
    const dotScale = Math.max(0.5, Math.min(2.5, (globe.r / 260) * Math.sqrt(100_000 / shown) * 0.7));
    // A dark disc under the clouds, so the gaps between tracers read as shadow, not space.
    const k = (2 * globe.r) / DISC;
    draw.sprite(disc, globe.cx, globe.cy, { scaleX: k, scaleY: k * FLAT, smooth: true });
    draw.sprites(dot, pos, shown, { alpha: 0.9, scaleX: dotScale, scaleY: dotScale, smooth: true }, { color: lit });
  } else {
    draw.sprites(dot, pos, shown, { alpha: 0.85 }, { color: lit });
    // The wind profile along the left edge: the measured jets that drive everything else.
    const scale = 0.35; // px per m/s
    const x0 = 46;
    draw.line(x0, 0, x0, h, 1, "#ffffff40");
    let px = x0 + wind[ROWS - 1] * scale;
    let py = 0;
    for (let y = 2; y <= h; y += 2) {
      const nx = x0 + wind[rowOf(LAT_MAX - (y / h) * 2 * LAT_MAX)] * scale;
      draw.line(px, py, nx, y, 1.5, "#cffb2d");
      px = nx;
      py = y;
    }
  }
  draw.end();
  const t2 = performance.now();
  projectMs += (t1 - t0 - projectMs) * 0.05;
  drawMs += (t2 - t1 - drawMs) * 0.05;
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) {
    stats.textContent = `${snap.n.toLocaleString()} tracers · ${clock(snap.days)}${snap.catchingUp ? " (jumping ahead)" : !paused && snap.rate < speed * 0.8 ? ` · running at ${span(snap.rate)} a second, the most this machine manages` : ""} · ${snap.named.length} named storms, ${EDDIES} eddies · ${Math.round(fps)} fps · simulate ${snap.stepMs.toFixed(1)} ms in a worker · project ${projectMs.toFixed(1)} ms · draw ${drawMs.toFixed(1)} ms · ${draw.kind}`;
    const hit = pointer.on ? fromScreen(pointer.x, pointer.y, w, h) : null;
    if (hit) {
      const [x, y] = hit;
      const u = wind[rowOf(y)];
      const named = snap.named.find((s) => inside(s, x, y, 1.2));
      probe.textContent = `${Math.abs(y).toFixed(1)}°${y < 0 ? "S" : "N"} · wind ${u > 0 ? "east" : "west"} ${Math.abs(u).toFixed(0)} m/s · ${belt[rowOf(y)] ? "belt" : "zone"}${named ? ` · ${named.name}` : ""}`;
    } else probe.textContent = "";
  }
  requestAnimationFrame(frame);
}

sim.postMessage({ count: n, speed });
setPaused(paused);
press("counts", "count", String(n));
setSpeed(speed);
frameView(view);
press("views", "view", view);
press("backends", "backend", backend);
requestAnimationFrame(frame);
