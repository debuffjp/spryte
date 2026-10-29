// The river's particle fluid, with no DOM: it runs in a worker (river-worker.ts) or, with
// ?worker=0, on the main thread. Double density relaxation (Clavet et al. 2005) over a uniform grid
// rebuilt every step with a counting sort; particle arrays are reordered into cell order so the
// neighbour loops read memory in order, and each particle's neighbours are found once per step.
// The scene, the inlet and collisions are shared with the multi-worker version (river-parallel.ts).

export const H = 9; // interaction radius in world units
export const REST = 4.2; // rest density
export const STIFF = 0.025;
export const STIFF_NEAR = 0.15;
export const GRAVITY = 0.12; // world units per step²
export const MAX_FLUID = 200_000;
// No particle moves more than this per step. The falls drop far enough to hit the pool at almost a
// whole interaction radius per step, which crushed particles together on impact and blasted them
// back up as spray; capping speed at about half the radius keeps every impact resolvable.
export const MAX_SPEED = H * 0.45;
/** Scales a velocity down to MAX_SPEED. */
export function clampSpeed(vxs: Float32Array, vys: Float32Array, i: number): void {
  const s2 = vxs[i] * vxs[i] + vys[i] * vys[i];
  if (s2 > MAX_SPEED * MAX_SPEED) {
    const f = MAX_SPEED / Math.sqrt(s2);
    vxs[i] *= f;
    vys[i] *= f;
  }
}
// The scene is laid out for BASE particles. More would overfill the basin and blow the fluid apart,
// so the whole scene grows by k = sqrt(count / BASE) instead, keeping the water at the same density.
export const BASE = 6_000; // about what the k = 1 scene holds at rest
export const MAX_K = Math.sqrt(MAX_FLUID / BASE);
export const MAX_CELLS = (Math.ceil((720 * MAX_K) / H) + 3) * (Math.ceil((400 * MAX_K) / H) + 3);

/** Scene geometry in world units at scale k. Rocks are kept in k = 1 units and scaled here too. */
export function geometry(k: number) {
  const WORLD_W = 720 * k;
  const WORLD_H = 400 * k;
  const FLOOR = WORLD_H - 12 * k;
  return {
    WORLD_W,
    WORLD_H,
    LIP_X: 380 * k,
    FLOOR,
    WEIR_X: WORLD_W - 70 * k,
    WEIR_TOP: FLOOR - 70 * k,
    WEIR_W: 14 * k,
    shelf: (x: number): number => (150 + (x / k) * 0.06) * k,
  };
}
export type Geometry = ReturnType<typeof geometry>;
export const scaleFor = (count: number): number => Math.max(1, Math.sqrt(Math.min(count, MAX_FLUID) / BASE));

export interface Rock {
  x: number;
  y: number;
  r: number;
}

/** The particle arrays both versions work on. */
export interface Particles {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  px: Float32Array; // position at the start of the step
  py: Float32Array;
}
const fieldsOf = (p: Particles) => [p.x, p.y, p.vx, p.vy, p.px, p.py];

// Water that leaves over the weir is marked with this x and waits in a queue at the inlet.
export const GONE = -1e9;
// Lattice spacing for new and re-entering water (near the rest spacing), and the inlet speed.
const SPACING = H * 0.4;
const INLET_SPEED = 1.8;

/** The inlet's state between steps: queued releases owed, the next slot, water in the scene. */
export interface Inlet {
  due: number;
  slot: number;
  total: number;
}

/**
 * Before a step: retire water marked GONE into the queue, add or drop water to match `count`, and
 * let queued water back in on evenly spaced inlet slots at the rate the river carries it away.
 * Random drop points used to land on other particles and boil the inlet into spray.
 * Returns the new number of live particles.
 */
export function admit(p: Particles, live: number, count: number, k: number, inlet: Inlet): number {
  const all = fieldsOf(p);
  for (let i = 0; i < live; ) {
    if (p.x[i] < GONE / 2) {
      live--;
      for (const a of all) a[i] = a[live];
    } else i++;
  }
  if (count > inlet.total) {
    live = addBlock(p, live, count - inlet.total, k);
    inlet.total = count;
  } else if (count < inlet.total) {
    inlet.total = count;
    live = Math.min(live, count);
  }
  const g = geometry(k);
  const rows = Math.max(1, Math.floor((60 * k) / SPACING));
  inlet.due += (rows * INLET_SPEED) / SPACING;
  while (inlet.due >= 1 && live < inlet.total) {
    inlet.due--;
    const i = live++;
    p.x[i] = 4 * k + (Math.random() - 0.5) * 0.2;
    p.y[i] = Math.min(g.shelf(0) - SPACING, 60 * k + (inlet.slot++ % rows) * SPACING);
    p.vx[i] = INLET_SPEED;
    p.vy[i] = 0;
    p.px[i] = p.x[i];
    p.py[i] = p.y[i];
  }
  if (inlet.due > rows) inlet.due = rows; // the queue is empty: don't bank releases
  return live;
}

/** Places n new particles on a lattice from the top of the scene down, above the ground. */
function addBlock(p: Particles, live: number, n: number, k: number): number {
  const g = geometry(k);
  let placed = 0;
  for (let row = 0; placed < n; row++) {
    const y = 10 * k + row * SPACING;
    if (y > g.FLOOR - SPACING) break;
    for (let x = SPACING + (row % 2) * SPACING * 0.5; x < g.WEIR_X - SPACING && placed < n; x += SPACING) {
      const ground = x < g.LIP_X ? g.shelf(x) : g.FLOOR;
      if (y > ground - SPACING) continue;
      const i = live + placed++;
      p.x[i] = x;
      p.y[i] = y;
      p.vx[i] = 0;
      p.vy[i] = 0;
      p.px[i] = x;
      p.py[i] = y;
    }
  }
  return live + placed;
}

/** Pushes particle i out of the walls, shelf, weir and rocks, and marks it GONE once past the weir. */
export function collide(p: Particles, i: number, g: Geometry, rocks: Rock[], k: number): void {
  let qx = p.x[i];
  let qy = p.y[i];
  if (qx > g.WORLD_W + 10 || qy > g.WORLD_H + 40) {
    p.x[i] = GONE;
    return;
  }
  if (qx < 2) qx = 2;
  if (qy > g.FLOOR) qy = g.FLOOR;
  if (qy < -200) qy = -200;
  if (qx < g.LIP_X) {
    const top = g.shelf(qx);
    if (qy > top) {
      if (g.LIP_X - qx < qy - top) qx = g.LIP_X;
      else qy = top;
    }
  }
  if (qx > g.WEIR_X && qx < g.WEIR_X + g.WEIR_W && qy > g.WEIR_TOP) {
    const dLeft = qx - g.WEIR_X;
    const dRight = g.WEIR_X + g.WEIR_W - qx;
    const dTop = qy - g.WEIR_TOP;
    if (dTop < dLeft && dTop < dRight) qy = g.WEIR_TOP;
    else if (dLeft < dRight) qx = g.WEIR_X;
    else qx = g.WEIR_X + g.WEIR_W;
  }
  for (const r of rocks) {
    const rx = r.x * k;
    const ry = r.y * k;
    const rr = r.r * k;
    const dx = qx - rx;
    const dy = qy - ry;
    const d2 = dx * dx + dy * dy;
    if (d2 < rr * rr) {
      const d = Math.sqrt(d2) || 1;
      qx = rx + (dx / d) * rr;
      qy = ry + (dy / d) * rr;
    }
  }
  p.x[i] = qx;
  p.y[i] = qy;
}

/** Rescales live particles when the scene grows or shrinks. */
export function rescale(p: Particles, live: number, f: number): void {
  for (let i = 0; i < live; i++) {
    p.x[i] *= f;
    p.y[i] *= f;
    p.px[i] *= f;
    p.py[i] *= f;
  }
}

// Single-thread state, used by river-worker.ts and the ?worker=0 path.
export const particles: Particles = {
  x: new Float32Array(MAX_FLUID),
  y: new Float32Array(MAX_FLUID),
  vx: new Float32Array(MAX_FLUID),
  vy: new Float32Array(MAX_FLUID),
  px: new Float32Array(MAX_FLUID),
  py: new Float32Array(MAX_FLUID),
};
export const { x, y, vx, vy, px: prevX, py: prevY } = particles;
export const state = { k: 1, live: 0, pairs: 0, reorder: true };
const inlet: Inlet = { due: 0, slot: 0, total: 0 };
let g = geometry(1);

let GW = Math.ceil(g.WORLD_W / H) + 2;
let GH = Math.ceil(g.WORLD_H / H) + 2;
let CELLS = GW * GH;
const cellStart = new Int32Array(MAX_CELLS + 1);
const cursor = new Int32Array(MAX_CELLS + 1);
const cellOf = new Int32Array(MAX_FLUID);
const sorted = new Int32Array(MAX_FLUID);
const scratch = new Float32Array(MAX_FLUID);
const scratchCells = new Int32Array(MAX_FLUID);
const fields = fieldsOf(particles);
const MAX_NEIGHBOURS = 96;
const nbJ = new Int32Array(MAX_NEIGHBOURS);
const nbQ = new Float32Array(MAX_NEIGHBOURS);
const nbX = new Float32Array(MAX_NEIGHBOURS);
const nbY = new Float32Array(MAX_NEIGHBOURS);

function setScale(next: number): void {
  if (next === state.k) return;
  rescale(particles, state.live, next / state.k);
  state.k = next;
  g = geometry(next);
  GW = Math.ceil(g.WORLD_W / H) + 2;
  GH = Math.ceil(g.WORLD_H / H) + 2;
  CELLS = GW * GH;
}

function buildGrid(n: number): void {
  cellStart.fill(0, 0, CELLS + 1);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(GW - 1, Math.max(0, Math.floor(x[i] / H) + 1));
    const cy = Math.min(GH - 1, Math.max(0, Math.floor(y[i] / H) + 1));
    const c = cy * GW + cx;
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < CELLS; c++) cellStart[c + 1] += cellStart[c];
  cursor.set(cellStart);
  for (let i = 0; i < n; i++) sorted[cursor[cellOf[i]]++] = i;
  if (!state.reorder) return;
  for (const a of fields) {
    for (let s = 0; s < n; s++) scratch[s] = a[sorted[s]];
    a.set(scratch.subarray(0, n));
  }
  for (let s = 0; s < n; s++) scratchCells[s] = cellOf[sorted[s]];
  cellOf.set(scratchCells.subarray(0, n));
  for (let s = 0; s < n; s++) sorted[s] = s;
}

function relax(n: number): number {
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    const c = cellOf[i];
    let density = 0;
    let near = 0;
    let found = 0;
    for (let oy = -GW; oy <= GW; oy += GW) {
      for (let ox = -1; ox <= 1; ox++) {
        const cell = c + oy + ox;
        if (cell < 0 || cell >= CELLS) continue;
        for (let s = cellStart[cell]; s < cellStart[cell + 1]; s++) {
          const j = sorted[s];
          if (j === i) continue;
          const dx = x[j] - xi;
          const dy = y[j] - yi;
          const d2 = dx * dx + dy * dy;
          if (d2 >= H * H || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const q = 1 - d / H;
          density += q * q;
          near += q * q * q;
          if (found < MAX_NEIGHBOURS) {
            nbJ[found] = j;
            nbQ[found] = q;
            nbX[found] = dx / d;
            nbY[found] = dy / d;
            found++;
          }
        }
      }
    }
    const pressure = STIFF * (density - REST);
    const pressureNear = STIFF_NEAR * near;
    let mx = 0;
    let my = 0;
    pairs += found;
    for (let m = 0; m < found; m++) {
      const q = nbQ[m];
      const push = (pressure * q + pressureNear * q * q) * 0.5;
      const ux = nbX[m] * push;
      const uy = nbY[m] * push;
      const j = nbJ[m];
      x[j] += ux;
      y[j] += uy;
      mx -= ux;
      my -= uy;
    }
    x[i] += mx;
    y[i] += my;
  }
  return pairs;
}

/** One simulation step: admit water, integrate, relax, collide. */
export function tick(count: number, rocks: Rock[]): void {
  const n = Math.min(count, MAX_FLUID);
  setScale(scaleFor(n));
  state.live = admit(particles, state.live, n, state.k, inlet);
  const live = state.live;
  for (let i = 0; i < live; i++) {
    vy[i] += GRAVITY;
    prevX[i] = x[i];
    prevY[i] = y[i];
    x[i] += vx[i];
    y[i] += vy[i];
  }
  buildGrid(live);
  state.pairs = relax(live);
  for (let i = 0; i < live; i++) {
    collide(particles, i, g, rocks, state.k);
    if (x[i] === GONE) continue;
    vx[i] = (x[i] - prevX[i]) * 0.998;
    vy[i] = (y[i] - prevY[i]) * 0.998;
    clampSpeed(vx, vy, i);
  }
}
