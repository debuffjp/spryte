// Waves mode: an ocean surface of particles with cresting Gerstner waves, spray thrown off the
// crests, and pebbles that skip across it, each touch driving a ripple simulation. Everything the
// mode draws (surface, spray, pebbles) goes into one set of arrays for a single sprites() call.
import { PALETTES, ramp } from "./palettes.ts";
import { type Camera, project, type View, view } from "./project3d.ts";

export type { Camera };

const TAU = Math.PI * 2;
const SIZE = 8; // the water is SIZE x SIZE world units
const EYE = 11; // camera distance in world units
const MAX_SURFACE = 1_000_000;
const MAX_SPRAY = 24_000;
const MAX_PEBBLES = 8;
const CAP = MAX_SURFACE + MAX_SPRAY + MAX_PEBBLES;
const GRAVITY = 6;

// Four waves: direction (radians), wavelength, amplitude. Steepness is shared out so the crests
// sharpen to a point without folding over (sum of Q·k·A stays under 1).
const WAVES = [
  { dir: 0.3, length: 4.2, amp: 0.36 },
  { dir: -0.5, length: 2.6, amp: 0.2 },
  { dir: 1.1, length: 1.7, amp: 0.1 },
  { dir: 0.05, length: 1.1, amp: 0.05 },
].map((w) => {
  const k = TAU / w.length;
  return { dx: Math.cos(w.dir), dy: Math.sin(w.dir), k, amp: w.amp, omega: Math.sqrt(9.8 * k) * 0.55, q: 0, lean: 0 };
});
{
  const total = WAVES.reduce((s, w) => s + w.k * w.amp, 0);
  for (const w of WAVES) {
    w.q = 0.95 / total;
    w.lean = w.q * w.amp;
  }
}
// Per-column and per-row sines and cosines for each wave (see the surface loop).
const MAX_SIDE = Math.ceil(Math.sqrt(MAX_SURFACE));
const colSin = new Float32Array(4 * MAX_SIDE);
const colCos = new Float32Array(4 * MAX_SIDE);
const rowSin = new Float32Array(4 * MAX_SIDE);
const rowCos = new Float32Array(4 * MAX_SIDE);
const PEAK = WAVES.reduce((s, w) => s + w.amp, 0);

// Elevation colours, trough to crest; replaced by setPalette().
let RAMP = ramp(PALETTES[1].stops);
export function setPalette(stops: number[]): void {
  RAMP = ramp(stops);
}

// Ripples: a damped wave equation on a grid laid over the water.
const R = 160;
let ripple = new Float32Array(R * R);
let previous = new Float32Array(R * R);
function stepRipples(): void {
  const next = previous; // reuse the older buffer
  for (let y = 1; y < R - 1; y++) {
    for (let x = 1; x < R - 1; x++) {
      const i = y * R + x;
      next[i] = ((ripple[i - 1] + ripple[i + 1] + ripple[i - R] + ripple[i + R]) * 0.5 - next[i]) * 0.986;
    }
  }
  previous = ripple;
  ripple = next;
}
function rippleAt(u: number, v: number): number {
  const x = u * (R - 1);
  const y = v * (R - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= R - 1 || y0 >= R - 1) return 0;
  const fx = x - x0;
  const fy = y - y0;
  const i = y0 * R + x0;
  const top = ripple[i] * (1 - fx) + ripple[i + 1] * fx;
  const bottom = ripple[i + R] * (1 - fx) + ripple[i + R + 1] * fx;
  return top * (1 - fy) + bottom * fy;
}
function splashRipple(u: number, v: number, strength: number, radius: number): void {
  const cx = u * (R - 1);
  const cy = v * (R - 1);
  for (let y = Math.max(1, Math.floor(cy - radius)); y < Math.min(R - 1, cy + radius); y++) {
    for (let x = Math.max(1, Math.floor(cx - radius)); x < Math.min(R - 1, cx + radius); x++) {
      const d = Math.hypot(x - cx, y - cy) / radius;
      if (d < 1) ripple[y * R + x] -= strength * (1 - d * d);
    }
  }
}

export const positions = new Float32Array(CAP * 2);
export const colors = new Uint32Array(CAP);
export const scales = new Float32Array(CAP);
export const timing = { sim: 0 };

const spray = {
  x: new Float32Array(MAX_SPRAY),
  y: new Float32Array(MAX_SPRAY),
  z: new Float32Array(MAX_SPRAY),
  vx: new Float32Array(MAX_SPRAY),
  vy: new Float32Array(MAX_SPRAY),
  vz: new Float32Array(MAX_SPRAY),
  life: new Float32Array(MAX_SPRAY),
};
let sprayNext = 0;
function emit(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
  const i = sprayNext;
  sprayNext = (sprayNext + 1) % MAX_SPRAY;
  spray.x[i] = x;
  spray.y[i] = y;
  spray.z[i] = z;
  spray.vx[i] = vx;
  spray.vy[i] = vy;
  spray.vz[i] = vz;
  spray.life[i] = 1.2 + Math.random() * 0.8;
}

interface Pebble {
  x: number;
  y: number;
  dx: number;
  dy: number;
  hop: number; // world units to the next touch
  travelled: number; // along the current hop
  bounces: number;
}
const pebbles: Pebble[] = [];

let rippleTime = 0;
let surfaceSide = 0;
let lastProjection = { W: 1, H: 1, unit: 1, camera: { yaw: 0, pitch: 0.5 } as Camera };

/** Where a screen pixel lands on the still water plane, in world units, or null above the horizon. */
function unproject(sx: number, sy: number): [number, number] | null {
  const { W, H, unit, camera } = lastProjection;
  const cy = Math.cos(camera.yaw);
  const sny = Math.sin(camera.yaw);
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const a = (sx - W / 2) / unit;
  const b = -(sy - H / 2) / unit;
  const denom = sp * EYE - b * cp;
  if (denom <= 0.01) return null;
  const ry = (-b * EYE) / denom;
  const f = EYE / (EYE - ry * cp);
  const rx = a / f;
  return [rx * cy + ry * sny, -rx * sny + ry * cy];
}

/** Skip a pebble from the near edge of the water toward a screen point. */
export function throwPebble(sx: number, sy: number): void {
  const target = unproject(sx, sy);
  if (!target) return;
  const start = unproject(lastProjection.W / 2, lastProjection.H * 1.1) ?? [0, -SIZE / 2];
  let dx = target[0] - start[0];
  let dy = target[1] - start[1];
  const d = Math.hypot(dx, dy) || 1;
  dx /= d;
  dy /= d;
  if (pebbles.length >= MAX_PEBBLES) pebbles.shift();
  pebbles.push({ x: start[0], y: start[1], dx, dy, hop: d, travelled: 0, bounces: 0 });
}

/** Simulates and projects everything; returns how many copies to draw. */
export function step(
  n: number,
  dt: number,
  now: number,
  W: number,
  H: number,
  dpr: number,
  camera: Camera,
  reducedMotion: boolean,
): number {
  const t0 = performance.now();
  const t = (now / 1000) * (reducedMotion ? 0.4 : 1);
  const unit = Math.min(W, H) * 0.1;
  lastProjection = { W, H, unit, camera: { ...camera } };
  const v3 = view(camera, W, H, unit, EYE);

  rippleTime += dt;
  while (rippleTime > 1 / 60) {
    stepRipples();
    rippleTime -= 1 / 60;
  }

  // Pebbles: fly in arcs between touches, each touch shorter, then sink with a bigger splash.
  for (let p = pebbles.length - 1; p >= 0; p--) {
    const pb = pebbles[p];
    const speed = 5 + pb.hop * 1.5;
    pb.travelled += speed * dt;
    if (pb.travelled >= pb.hop) {
      pb.x += pb.dx * pb.hop;
      pb.y += pb.dy * pb.hop;
      const u = pb.x / SIZE + 0.5;
      const v = pb.y / SIZE + 0.5;
      const last = pb.bounces >= 6 || pb.hop < 0.25;
      splashRipple(u, v, last ? 0.6 : 0.35, last ? 5 : 3);
      for (let s = 0; s < (last ? 400 : 160); s++) {
        const a = Math.random() * TAU;
        const r = Math.random() * (last ? 1.6 : 1);
        emit(
          pb.x,
          pb.y,
          0.02,
          Math.cos(a) * r + pb.dx * (last ? 0 : 1.2),
          Math.sin(a) * r + pb.dy * (last ? 0 : 1.2),
          1.5 + Math.random() * (last ? 3 : 2),
        );
      }
      if (last || Math.abs(pb.x) > SIZE / 2 || Math.abs(pb.y) > SIZE / 2) {
        pebbles.splice(p, 1);
        continue;
      }
      pb.bounces++;
      pb.hop *= 0.62;
      pb.travelled = 0;
    }
  }

  // The surface: a square grid of particles, each displaced by every wave and the ripples.
  const side = Math.floor(Math.sqrt(Math.min(n, MAX_SURFACE)));
  surfaceSide = side;
  let count = 0;
  // A wave's phase is k·dx·px − ωt (depends only on the column) plus k·dy·py (only on the row), so
  // the sines and cosines are worked out once per column and once per row, and each point combines
  // them with sin(A+B) = sA·cB + cA·sB and cos(A+B) = cA·cB − sA·sB: no trig in the inner loop.
  for (let w = 0; w < WAVES.length; w++) {
    const wave = WAVES[w];
    for (let i = 0; i < side; i++) {
      const p = ((i + 0.5) / side - 0.5) * SIZE;
      const a = wave.k * wave.dx * p - wave.omega * t;
      const b = wave.k * wave.dy * p;
      colSin[w * MAX_SIDE + i] = Math.sin(a);
      colCos[w * MAX_SIDE + i] = Math.cos(a);
      rowSin[w * MAX_SIDE + i] = Math.sin(b);
      rowCos[w * MAX_SIDE + i] = Math.cos(b);
    }
  }
  for (let gy = 0; gy < side; gy++) {
    const v = (gy + 0.5) / side;
    const py = (v - 0.5) * SIZE;
    for (let gx = 0; gx < side; gx++) {
      const u = (gx + 0.5) / side;
      const px = (u - 0.5) * SIZE;
      let x = px;
      let y = py;
      let z = 0;
      for (let w = 0; w < WAVES.length; w++) {
        const wave = WAVES[w];
        const ci = w * MAX_SIDE + gx;
        const ri = w * MAX_SIDE + gy;
        const sA = colSin[ci];
        const cA = colCos[ci];
        const sB = rowSin[ri];
        const cB = rowCos[ri];
        const c = cA * cB - sA * sB;
        x += wave.lean * wave.dx * c;
        y += wave.lean * wave.dy * c;
        z += wave.amp * (sA * cB + cA * sB);
      }
      z += rippleAt(u, v);
      // Spray: a few particles leave the highest crests every frame.
      if (z > PEAK * 0.7 && Math.random() < 0.012) emit(x, y, z, WAVES[0].dx * 1.2, WAVES[0].dy * 1.2, 0.8 + Math.random());
      count = put(v3, count, x, y, z, 0.5 * dpr);
      const e = Math.max(0, Math.min(63, Math.floor((z / PEAK) * 32 + 32)));
      colors[count - 1] = ((RAMP[e] << 8) | (0x50 + e * 2)) >>> 0;
    }
  }

  // Spray falls under gravity until it hits the water or runs out of life.
  for (let i = 0; i < MAX_SPRAY; i++) {
    if (spray.life[i] <= 0) continue;
    spray.life[i] -= dt;
    spray.vz[i] -= GRAVITY * dt;
    spray.x[i] += spray.vx[i] * dt;
    spray.y[i] += spray.vy[i] * dt;
    spray.z[i] += spray.vz[i] * dt;
    if (spray.z[i] < -PEAK) spray.life[i] = 0;
    count = put(v3, count, spray.x[i], spray.y[i], spray.z[i], 0.35 * dpr);
    colors[count - 1] = 0xffffff00 | Math.round(Math.min(1, spray.life[i]) * 0xb0);
  }

  // Pebbles in flight, drawn larger.
  for (const pb of pebbles) {
    const f = pb.travelled / pb.hop;
    const arc = Math.sin(f * Math.PI) * pb.hop * 0.25;
    count = put(v3, count, pb.x + pb.dx * pb.travelled, pb.y + pb.dy * pb.travelled, arc, 1.6 * dpr);
    colors[count - 1] = 0xe8ecdfff;
  }
  timing.sim += (performance.now() - t0 - timing.sim) * 0.05;
  return count;
}

function put(v3: View, i: number, x: number, y: number, z: number, size: number): number {
  project(v3, positions, scales, i, x, y, z, size);
  return i + 1;
}

/** How many surface particles there are along each side, for the stats line. */
export function side(): number {
  return surfaceSide;
}
