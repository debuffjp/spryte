// River mode: a particle fluid in side view. Water pours in upstream, runs along a shelf, goes over
// the falls into a basin, and leaves over a weir to come round again. Particles push on their
// neighbours, so the water pools, sloshes and piles up behind the rocks you drag into it.
// The simulation (river-sim.ts) runs in a worker, so drawing never waits for it: each frame draws
// the particles part way between the worker's last two steps. ?worker=0 runs it on the main thread
// instead, to compare.
import * as par from "./river-parallel.ts";
import * as sim from "./river-sim.ts";

const params = new URLSearchParams(location.search);
const useWorker = params.get("worker") !== "0" && typeof Worker !== "undefined";
const reorder = params.get("reorder") !== "0";

export const positions = new Float32Array(sim.MAX_FLUID * 2); // backing pixels, for drawing
export const colors = new Uint32Array(sim.MAX_FLUID);
export const scales = new Float32Array(sim.MAX_FLUID);
export const timing = { sim: 0, pairs: 0, stepsPerSecond: 0 };

// Rocks in k = 1 units; the simulation scales them with the scene.
export const rocks: sim.Rock[] = [
  { x: 250, y: 132, r: 20 },
  { x: 520, y: 362, r: 26 },
  { x: 600, y: 60, r: 18 },
  { x: 660, y: 60, r: 24 },
];

// Water colours, slow to fast; replaced by setPalette().
let ramp: number[] = [0x1e3a8a, 0x2f7fd0, 0x38bdf8, 0xc8f1ff, 0xffffff];
export function setPalette(stops: number[]): void {
  ramp = stops;
}

// The latest step: [x0, y0, x1, y1, speed] per particle, when it arrived, and the gap between steps.
let frame: Float32Array<ArrayBufferLike> = new Float32Array(0);
let live = 0;
let k = 1;
let arrived = 0;
let interval = 1000 / 60;
let lastArrival = 0;
let wantCount = 0;

// Several workers over shared memory when the page is cross-origin isolated; ?workers=N picks how
// many (default: a few fewer than the CPU's cores, up to 8).
const cores = navigator.hardwareConcurrency || 4;
const workerCount = Number(params.get("workers")) || Math.min(8, Math.max(2, cores - 4));
const parallel = useWorker && workerCount > 1 && globalThis.crossOriginIsolated === true;
let shared: { ctl: Int32Array; rocks: Float32Array; snaps: Float32Array; seq: number } | null = null;
if (parallel) {
  const buffers = par.allocate();
  const ctl = new Int32Array(buffers.control);
  Atomics.store(ctl, par.C.WORKERS, workerCount);
  shared = { ctl, rocks: new Float32Array(buffers.rocks), snaps: new Float32Array(buffers.snaps), seq: 0 };
  shared.rocks[par.ROCK_FLOATS] = 1;
  writeRocks();
  for (let index = 0; index < workerCount; index++) {
    const w = new Worker(new URL("./river-parallel-worker.ts", import.meta.url), { type: "module" });
    w.postMessage({ buffers, index });
  }
}
function writeRocks(): void {
  if (!shared) return;
  for (let r = 0; r < 4; r++) {
    const rock = rocks[r];
    shared.rocks[r * 3] = rock ? rock.x : 0;
    shared.rocks[r * 3 + 1] = rock ? rock.y : 0;
    shared.rocks[r * 3 + 2] = rock ? rock.r : 0;
  }
}
/** Picks up the latest finished step from the shared workers, if there is a new one. */
function readShared(): void {
  if (!shared) return;
  const { ctl } = shared;
  const seq = Atomics.load(ctl, par.C.SEQ);
  if (seq === shared.seq) return;
  shared.seq = seq;
  const front = Atomics.load(ctl, par.C.FRONT);
  frame = shared.snaps.subarray(front * par.SNAP_FLOATS * sim.MAX_FLUID, (front + 1) * par.SNAP_FLOATS * sim.MAX_FLUID);
  live = Atomics.load(ctl, par.C.LIVE);
  k = shared.rocks[par.ROCK_FLOATS] || 1;
  timing.pairs = Atomics.load(ctl, par.C.LAST_PAIRS);
  timing.sim += (Atomics.load(ctl, par.C.STEP_US) / 1000 - timing.sim) * 0.1;
  const now = performance.now();
  if (lastArrival) {
    interval += (now - lastArrival - interval) * 0.1;
    timing.stepsPerSecond = 1000 / interval;
  }
  lastArrival = now;
  arrived = now;
}

let worker: Worker | null = null;
if (useWorker && !parallel) {
  worker = new Worker(new URL("./river-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data;
    frame = m.packed;
    live = m.live;
    k = m.k;
    timing.pairs = m.pairs;
    timing.sim += (m.ms - timing.sim) * 0.1;
    const now = performance.now();
    if (lastArrival) {
      interval += (now - lastArrival - interval) * 0.1;
      timing.stepsPerSecond = 1000 / interval;
    }
    lastArrival = now;
    arrived = now;
  };
  worker.postMessage({ count: 0, rocks, reorder });
}
function sendRocks(): void {
  worker?.postMessage({ rocks });
  writeRocks();
}

// Main-thread fallback: run steps inline and pack the same layout.
let accumulator = 0;
function stepInline(count: number, dt: number): void {
  sim.state.reorder = reorder;
  accumulator += dt;
  const t0 = performance.now();
  let steps = 0;
  while (accumulator >= 1 / 60 && steps < (timing.sim > 12 ? 1 : 2)) {
    accumulator -= 1 / 60;
    steps++;
    sim.tick(count, rocks);
  }
  if (accumulator > 1 / 60) accumulator = 0;
  if (!steps) return;
  live = sim.state.live;
  k = sim.state.k;
  if (frame.length < live * 5) frame = new Float32Array(sim.MAX_FLUID * 5);
  for (let i = 0; i < live; i++) {
    const o = i * 5;
    frame[o] = frame[o + 2] = sim.x[i];
    frame[o + 1] = frame[o + 3] = sim.y[i];
    frame[o + 4] = Math.hypot(sim.vx[i], sim.vy[i]);
  }
  timing.pairs = sim.state.pairs;
  timing.sim += (performance.now() - t0 - timing.sim) * 0.05;
  timing.stepsPerSecond = steps * 60;
  arrived = performance.now();
}

let view = { s: 1, ox: 0, oy: 0 };

/** Places the water on screen; returns how many copies to draw. */
export function step(
  n: number,
  dt: number,
  now: number,
  W: number,
  Hpx: number,
  _dpr: number,
  _camera: unknown,
  reducedMotion: boolean,
): number {
  if (n !== wantCount) {
    wantCount = n;
    worker?.postMessage({ count: n });
    if (shared) Atomics.store(shared.ctl, par.C.COUNT, n);
  }
  if (shared) readShared();
  else if (!worker) stepInline(n, dt * (reducedMotion ? 0.5 : 1));

  const g = sim.geometry(k);
  const s = Math.min(W / g.WORLD_W, Hpx / g.WORLD_H);
  const ox = (W - g.WORLD_W * s) / 2;
  const oy = (Hpx - g.WORLD_H * s) / 2;
  view = { s, ox, oy };
  const size = (sim.H * 0.7 * s) / 16; // the disc sprite is 16 px
  const last = ramp.length;
  // How far between the worker's last two steps this frame falls. Drawing one step behind costs a
  // little latency and buys smooth motion when the simulation runs slower than the display.
  const t = Math.min(1, (performance.now() - arrived) / interval);
  void now;
  for (let i = 0; i < live; i++) {
    const o = i * 5;
    positions[i * 2] = ox + (frame[o] + (frame[o + 2] - frame[o]) * t) * s;
    positions[i * 2 + 1] = oy + (frame[o + 1] + (frame[o + 3] - frame[o + 1]) * t) * s;
    scales[i] = size;
    const speed = Math.min(0.999, frame[o + 4] / 4);
    colors[i] = ((ramp[Math.floor(speed * last)] << 8) | 0xb0) >>> 0;
  }
  return live;
}

interface SceneDraw {
  rect(x: number, y: number, w: number, h: number, color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
}

/** Draws the shelf, cliff, basin, weir and rocks behind the water, in backing pixels. */
export function drawScene(draw: SceneDraw, poly: (points: number[], color: string) => void): void {
  const { s, ox, oy } = view;
  const g = sim.geometry(k);
  const X = (wx: number): number => ox + wx * s;
  const Y = (wy: number): number => oy + wy * s;
  const ground = "#3b4630";
  poly([X(0), Y(g.shelf(0)), X(g.LIP_X), Y(g.shelf(g.LIP_X)), X(g.LIP_X), Y(g.WORLD_H), X(0), Y(g.WORLD_H)], ground);
  draw.rect(X(0), Y(g.FLOOR), g.WORLD_W * s, (g.WORLD_H - g.FLOOR) * s, ground);
  draw.rect(X(g.WEIR_X), Y(g.WEIR_TOP), g.WEIR_W * s, (g.FLOOR - g.WEIR_TOP) * s, ground);
  for (const r of rocks) draw.circle(X(r.x * k), Y(r.y * k), r.r * k * s, r === held ? "#a3ab96" : "#6b7360");
}

// Dragging rocks: pick the one under the pointer and move it there on each move.
let held: sim.Rock | null = null;
function toUnits(px: number, py: number): [number, number] {
  return [(px - view.ox) / view.s / k, (py - view.oy) / view.s / k];
}
export function grab(px: number, py: number): boolean {
  const [ux, uy] = toUnits(px, py);
  held = rocks.find((r) => Math.hypot(r.x - ux, r.y - uy) < r.r + 6) ?? null;
  return held !== null;
}
export function drag(px: number, py: number): void {
  if (!held) return;
  const [ux, uy] = toUnits(px, py);
  held.x = Math.max(held.r, Math.min(720 - held.r, ux));
  held.y = Math.max(held.r, Math.min(388, uy));
  sendRocks();
}
export function release(): void {
  held = null;
}

/** Live particle count, neighbour pairs and where the simulation runs, for the stats line. */
export function census(): string {
  const where = shared
    ? `${workerCount} shared-memory workers, ${Math.round(timing.stepsPerSecond)} steps/s`
    : worker
      ? `worker, ${Math.round(timing.stepsPerSecond)} steps/s`
      : "main thread";
  return `fluid ${live.toLocaleString()}, ${(timing.pairs / 1e6).toFixed(2)}M neighbour pairs per step, ${where}`;
}
