// Galaxies mode: two spiral galaxies on a collision course. Each galaxy is a heavy core with a disc
// of stars in circular orbits around it; the two cores pull on each other, and every star feels
// both cores (softened gravity, a leapfrog step per frame). As the cores swing past, the discs tear
// into tidal tails and bridges, the classic Toomre experiment. Stars are drawn additively in one
// sprites() call, coloured by which galaxy they started in and how far from its core.

import { PALETTES, ramp } from "./palettes.ts";
import { type Camera, project, view } from "./project3d.ts";

const MAX_STARS = 1_000_000;
const EYE = 14;
const SOFT2 = 0.08 * 0.08; // softening, so stars near a core don't fling off
const SPEED = 0.9; // simulated time per real second

export const positions = new Float32Array(MAX_STARS * 2);
export const colors = new Uint32Array(MAX_STARS);
export const scales = new Float32Array(MAX_STARS);
export const timing = { sim: 0 };

const px = new Float32Array(MAX_STARS);
const py = new Float32Array(MAX_STARS);
const pz = new Float32Array(MAX_STARS);
const vx = new Float32Array(MAX_STARS);
const vy = new Float32Array(MAX_STARS);
const vz = new Float32Array(MAX_STARS);
const tint = new Uint8Array(MAX_STARS); // ramp index, fixed at birth
let made = 0; // stars set up for the current encounter
let shade = { a: ramp(PALETTES[0].stops.slice(0, 3)), b: ramp(PALETTES[0].stops.slice(2)) };
export function setPalette(stops: number[]): void {
  shade = { a: ramp(stops.slice(0, 3)), b: ramp(stops.slice(2)) };
  for (let i = 0; i < made; i++) recolour(i);
}

interface Core {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  m: number;
}
const cores: Core[] = [];
let share = 0.6; // fraction of stars in the first galaxy

function rand(): number {
  return Math.random();
}

/** Sets up a new encounter: two discs at random tilts, falling toward each other. */
export function reset(): void {
  const tiltA = rand() * Math.PI;
  const tiltB = rand() * Math.PI;
  const approach = (rand() - 0.5) * 1.2;
  cores.length = 0;
  cores.push({ x: -2.6, y: -0.6 + approach, z: 0, vx: 0.38, vy: 0.12, vz: 0, m: 1 });
  cores.push({ x: 2.6, y: 0.6 - approach, z: 0.3, vx: -0.5, vy: -0.16, vz: 0, m: 0.7 });
  share = 0.6;
  discs = [
    { tilt: tiltA, spin: rand() < 0.5 ? 1 : -1 },
    { tilt: tiltB, spin: rand() < 0.5 ? 1 : -1 },
  ];
  made = 0;
}
let discs: { tilt: number; spin: number }[] = [];

function makeStar(i: number, n: number): void {
  const g = i < n * share ? 0 : 1;
  const core = cores[g];
  const disc = discs[g];
  // Exponential disc: most stars near the middle, a thin tail out to about 1.4.
  const r = Math.min(1.4, 0.06 - Math.log(1 - rand() * 0.98) * 0.32);
  const a = rand() * Math.PI * 2;
  const x = Math.cos(a) * r;
  let y = Math.sin(a) * r;
  let z = (rand() - 0.5) * 0.04;
  // Circular speed for softened gravity from the core alone.
  const v = Math.sqrt((core.m * r * r) / (r * r + SOFT2) ** 1.5) * disc.spin;
  const ux = -Math.sin(a) * v;
  let uy = Math.cos(a) * v;
  let uz = 0;
  // Tilt the disc about the x axis.
  const ct = Math.cos(disc.tilt);
  const st = Math.sin(disc.tilt);
  [y, z] = [y * ct - z * st, y * st + z * ct];
  [uy, uz] = [uy * ct - uz * st, uy * st + uz * ct];
  px[i] = core.x + x;
  py[i] = core.y + y;
  pz[i] = core.z + z;
  vx[i] = core.vx + ux;
  vy[i] = core.vy + uy;
  vz[i] = core.vz + uz;
  tint[i] = Math.min(63, Math.floor((r / 1.4) * 64)) | (g << 6);
  recolour(i);
}
function recolour(i: number): void {
  const t = tint[i];
  const c = (t & 64 ? shade.b : shade.a)[t & 63];
  colors[i] = ((c << 8) | 0xff) >>> 0;
}

reset();

/** Simulates and projects the stars; returns how many copies to draw. */
export function step(
  n: number,
  dt: number,
  _now: number,
  W: number,
  H: number,
  dpr: number,
  camera: Camera,
  reducedMotion: boolean,
): number {
  const t0 = performance.now();
  const count = Math.min(n, MAX_STARS);
  if (made > count) made = count;
  // New stars join the current encounter at their galaxy's present core position.
  while (made < count) makeStar(made++, count);

  const h = Math.min(dt, 1 / 30) * SPEED * (reducedMotion ? 0.4 : 1);
  // The two cores, in small substeps (they're only two bodies).
  for (let s = 0; s < 8; s++) {
    const [a, b] = cores;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const inv = 1 / (dx * dx + dy * dy + dz * dz + SOFT2) ** 1.5;
    const sh = h / 8;
    a.vx += dx * inv * b.m * sh;
    a.vy += dy * inv * b.m * sh;
    a.vz += dz * inv * b.m * sh;
    b.vx -= dx * inv * a.m * sh;
    b.vy -= dy * inv * a.m * sh;
    b.vz -= dz * inv * a.m * sh;
    for (const c of cores) {
      c.x += c.vx * sh;
      c.y += c.vy * sh;
      c.z += c.vz * sh;
    }
  }
  const [A, B] = cores;
  // Keep the pair centred on screen: draw relative to their centre of mass.
  const cmx = (A.x * A.m + B.x * B.m) / (A.m + B.m);
  const cmy = (A.y * A.m + B.y * B.m) / (A.m + B.m);
  const cmz = (A.z * A.m + B.z * B.m) / (A.m + B.m);

  const v3 = view(camera, W, H, Math.min(W, H) * 0.2, EYE);
  const size = 0.32 * dpr;
  for (let i = 0; i < count; i++) {
    let x = px[i];
    let y = py[i];
    let z = pz[i];
    // Gravity from both cores, then a kick-drift step.
    let dx = A.x - x;
    let dy = A.y - y;
    let dz = A.z - z;
    // m / r³ as m / (r² · √r²): ** 1.5 goes through a general power function and cost about a third
    // of the frame at 1M stars.
    let r2 = dx * dx + dy * dy + dz * dz + SOFT2;
    let inv = A.m / (r2 * Math.sqrt(r2));
    let ax = dx * inv;
    let ay = dy * inv;
    let az = dz * inv;
    dx = B.x - x;
    dy = B.y - y;
    dz = B.z - z;
    r2 = dx * dx + dy * dy + dz * dz + SOFT2;
    inv = B.m / (r2 * Math.sqrt(r2));
    ax += dx * inv;
    ay += dy * inv;
    az += dz * inv;
    vx[i] += ax * h;
    vy[i] += ay * h;
    vz[i] += az * h;
    x += vx[i] * h;
    y += vy[i] * h;
    z += vz[i] * h;
    px[i] = x;
    py[i] = y;
    pz[i] = z;
    // Project around the centre of mass, so the pair stays centred.
    project(v3, positions, scales, i, x - cmx, y - cmy, z - cmz, size);
  }
  timing.sim += (performance.now() - t0 - timing.sim) * 0.05;
  return count;
}
