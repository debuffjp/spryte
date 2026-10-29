// One of several workers that run the river's fluid together over shared memory. Every worker takes
// a slice of the particles and they step in lockstep, meeting at a barrier between phases:
//
//   integrate → (worker 0) build the grid and reorder → density → displacement → apply and collide
//
// The single-worker version lets each particle push its neighbours directly, which two workers can't
// do at once. Here each particle sums the push it receives from every neighbour (its own pressure
// and theirs, half each) and writes only to itself: the same pair forces, applied all at once.
import {
  admit,
  clampSpeed,
  collide,
  GONE,
  GRAVITY,
  geometry,
  H,
  type Inlet,
  MAX_CELLS,
  MAX_FLUID,
  type Particles,
  REST,
  type Rock,
  rescale,
  STIFF,
  STIFF_NEAR,
  scaleFor,
} from "./river-sim.ts";

// How much of the pair push to apply per step. Every particle moves at once from densities taken at
// the start of the step, so full strength overshoots and the water boils into spray; damping it
// stands in for the settling the one-at-a-time version gets for free.
const RELAX = 0.1;
const ITERATIONS = 3;

// Float fields, each MAX_FLUID long, in one shared buffer.
export const F = { X: 0, Y: 1, VX: 2, VY: 3, PX: 4, PY: 5, DEN: 6, NEAR: 7, DX: 8, DY: 9 } as const;
export const FIELD_COUNT = 10;
// Control slots (Int32).
export const C = {
  BAR_COUNT: 0,
  BAR_GEN: 1,
  LIVE: 2,
  COUNT: 3,
  FRONT: 4,
  SEQ: 5,
  WORKERS: 6,
  PAIRS: 7,
  STEP_US: 8,
  LAST_PAIRS: 9,
  TOTAL: 10,
} as const;
export const CONTROL_INTS = 32;
export const ROCK_FLOATS = 4 * 3; // up to 4 rocks: x, y, r in k = 1 units
export const SNAP_FLOATS = 5; // per particle: x0, y0, x1, y1, speed
export { MAX_CELLS };

export interface Buffers {
  fields: SharedArrayBuffer; // Float32, FIELD_COUNT * MAX_FLUID
  snaps: SharedArrayBuffer; // Float32, 2 * SNAP_FLOATS * MAX_FLUID (double buffered for the page)
  cells: SharedArrayBuffer; // Int32: cellOf (MAX_FLUID), sorted (MAX_FLUID), cellStart (MAX_CELLS + 1)
  control: SharedArrayBuffer; // Int32, CONTROL_INTS
  rocks: SharedArrayBuffer; // Float32, ROCK_FLOATS, plus k after them
}

export function allocate(): Buffers {
  return {
    fields: new SharedArrayBuffer(FIELD_COUNT * MAX_FLUID * 4),
    snaps: new SharedArrayBuffer(2 * SNAP_FLOATS * MAX_FLUID * 4),
    cells: new SharedArrayBuffer((2 * MAX_FLUID + MAX_CELLS + 1) * 4),
    control: new SharedArrayBuffer(CONTROL_INTS * 4),
    rocks: new SharedArrayBuffer((ROCK_FLOATS + 1) * 4),
  };
}

/** The worker loop: never returns. Started by river-parallel-worker.ts. */
export function run(b: Buffers, index: number): void {
  const fields = new Float32Array(b.fields);
  const f = (field: number) => fields.subarray(field * MAX_FLUID, (field + 1) * MAX_FLUID);
  const x = f(F.X);
  const y = f(F.Y);
  const vx = f(F.VX);
  const vy = f(F.VY);
  const px = f(F.PX);
  const py = f(F.PY);
  const den = f(F.DEN);
  const near = f(F.NEAR);
  const ddx = f(F.DX);
  const ddy = f(F.DY);
  const all = [x, y, vx, vy, px, py];
  const particles: Particles = { x, y, vx, vy, px, py };
  const snaps = new Float32Array(b.snaps);
  const cells = new Int32Array(b.cells);
  const cellOf = cells.subarray(0, MAX_FLUID);
  const sorted = cells.subarray(MAX_FLUID, 2 * MAX_FLUID);
  const cellStart = cells.subarray(2 * MAX_FLUID);
  const ctl = new Int32Array(b.control);
  const rockData = new Float32Array(b.rocks);
  const workers = Atomics.load(ctl, C.WORKERS);
  // Worker 0's private scratch for the serial grid phase.
  const scratch = index === 0 ? new Float32Array(MAX_FLUID) : new Float32Array(0);
  const cursor = index === 0 ? new Int32Array(MAX_CELLS + 1) : new Int32Array(0);
  const pace = new Int32Array(new SharedArrayBuffer(4)); // something to Atomics.wait on for pacing
  let deadline = performance.now();

  function barrier(): void {
    const gen = Atomics.load(ctl, C.BAR_GEN);
    if (Atomics.add(ctl, C.BAR_COUNT, 1) === workers - 1) {
      Atomics.store(ctl, C.BAR_COUNT, 0);
      Atomics.add(ctl, C.BAR_GEN, 1);
      Atomics.notify(ctl, C.BAR_GEN);
    } else {
      while (Atomics.load(ctl, C.BAR_GEN) === gen) Atomics.wait(ctl, C.BAR_GEN, gen);
    }
  }

  let k = 1;
  const inlet: Inlet = { due: 0, slot: 0, total: 0 };
  for (;;) {
    const t0 = performance.now();
    // Worker 0: pacing, scale and pouring, while the others wait at the barrier.
    if (index === 0) {
      const count = Math.min(Atomics.load(ctl, C.COUNT), MAX_FLUID);
      let live = Atomics.load(ctl, C.LIVE);
      const next = scaleFor(count);
      if (next !== k) {
        rescale(particles, live, next / k);
        k = next;
        rockData[ROCK_FLOATS] = k;
      }
      live = admit(particles, live, count, k, inlet);
      Atomics.store(ctl, C.LIVE, live);
      Atomics.store(ctl, C.TOTAL, inlet.total);
      Atomics.store(ctl, C.PAIRS, 0);
    }
    barrier();
    k = rockData[ROCK_FLOATS] || 1;
    const live = Atomics.load(ctl, C.LIVE);
    const g = geometry(k);
    const GW = Math.ceil(g.WORLD_W / H) + 2;
    const GH = Math.ceil(g.WORLD_H / H) + 2;
    const CELLS = GW * GH;
    const chunk = Math.ceil(live / workers);
    const lo = Math.min(live, index * chunk);
    const hi = Math.min(live, lo + chunk);

    // Integrate.
    for (let i = lo; i < hi; i++) {
      vy[i] += GRAVITY;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += vx[i];
      y[i] += vy[i];
    }
    barrier();

    // Worker 0 builds the grid and reorders every array into cell order.
    if (index === 0) {
      cellStart.fill(0, 0, CELLS + 1);
      for (let i = 0; i < live; i++) {
        const cx = Math.min(GW - 1, Math.max(0, Math.floor(x[i] / H) + 1));
        const cy = Math.min(GH - 1, Math.max(0, Math.floor(y[i] / H) + 1));
        const c = cy * GW + cx;
        cellOf[i] = c;
        cellStart[c + 1]++;
      }
      for (let c = 0; c < CELLS; c++) cellStart[c + 1] += cellStart[c];
      cursor.set(cellStart.subarray(0, CELLS + 1));
      for (let i = 0; i < live; i++) sorted[cursor[cellOf[i]]++] = i;
      for (const a of all) {
        for (let s = 0; s < live; s++) scratch[s] = a[sorted[s]];
        a.set(scratch.subarray(0, live));
      }
      // After the reorder, a particle's cell is just where its slot falls in cellStart.
      for (let c = 0; c < CELLS; c++) for (let s = cellStart[c]; s < cellStart[c + 1]; s++) cellOf[s] = c;
    }
    barrier();

    // ITERATIONS rounds of density then displacement, each round settling on the last one's
    // positions (the grid from the start of the step is close enough for both).
    let pairs = 0;
    for (let round = 0; round < ITERATIONS; round++) {
      if (round > 0) {
        for (let i = lo; i < hi; i++) {
          x[i] += ddx[i];
          y[i] += ddy[i];
        }
        barrier();
      }
      // Density and near density, reading positions only.
      for (let i = lo; i < hi; i++) {
        const xi = x[i];
        const yi = y[i];
        const c = cellOf[i];
        let d = 0;
        let dn = 0;
        for (let oy = -GW; oy <= GW; oy += GW) {
          for (let ox = -1; ox <= 1; ox++) {
            const cell = c + oy + ox;
            if (cell < 0 || cell >= CELLS) continue;
            for (let j = cellStart[cell]; j < cellStart[cell + 1]; j++) {
              if (j === i) continue;
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 >= H * H) continue;
              const q = 1 - Math.sqrt(d2) / H;
              d += q * q;
              dn += q * q * q;
            }
          }
        }
        den[i] = STIFF * (d - REST); // stored as pressure from here on
        near[i] = STIFF_NEAR * dn;
      }
      barrier();

      // Displacement: the push each particle receives from all its neighbours.
      for (let i = lo; i < hi; i++) {
        const xi = x[i];
        const yi = y[i];
        const pi = den[i];
        const ni = near[i];
        const c = cellOf[i];
        let mx = 0;
        let my = 0;
        for (let oy = -GW; oy <= GW; oy += GW) {
          for (let ox = -1; ox <= 1; ox++) {
            const cell = c + oy + ox;
            if (cell < 0 || cell >= CELLS) continue;
            for (let j = cellStart[cell]; j < cellStart[cell + 1]; j++) {
              if (j === i) continue;
              const dx = x[j] - xi;
              const dy = y[j] - yi;
              const d2 = dx * dx + dy * dy;
              if (d2 >= H * H || d2 === 0) continue;
              pairs++;
              const dist = Math.sqrt(d2);
              const q = 1 - dist / H;
              const push = ((pi + den[j]) * q + (ni + near[j]) * q * q) * RELAX;
              mx -= (dx / dist) * push;
              my -= (dy / dist) * push;
            }
          }
        }
        ddx[i] = mx;
        ddy[i] = my;
      }
      barrier();
    }
    Atomics.add(ctl, C.PAIRS, Math.round(pairs / ITERATIONS));

    // Apply, collide, update velocity, recycle; then write this slice into the back snapshot.
    const rocks: Rock[] = [];
    for (let r = 0; r < 4; r++)
      if (rockData[r * 3 + 2] > 0) rocks.push({ x: rockData[r * 3], y: rockData[r * 3 + 1], r: rockData[r * 3 + 2] });
    const back = (1 - Atomics.load(ctl, C.FRONT)) * SNAP_FLOATS * MAX_FLUID;
    for (let i = lo; i < hi; i++) {
      x[i] += ddx[i];
      y[i] += ddy[i];
      collide(particles, i, g, rocks, k); // past the weir, it's marked GONE and queues next step
      if (x[i] !== GONE) {
        vx[i] = (x[i] - px[i]) * 0.998;
        vy[i] = (y[i] - py[i]) * 0.998;
        clampSpeed(vx, vy, i);
      }
      const o = back + i * SNAP_FLOATS;
      snaps[o] = px[i];
      snaps[o + 1] = py[i];
      snaps[o + 2] = x[i];
      snaps[o + 3] = y[i];
      snaps[o + 4] = Math.hypot(vx[i], vy[i]);
    }
    barrier();

    if (index === 0) {
      Atomics.store(ctl, C.FRONT, 1 - Atomics.load(ctl, C.FRONT));
      Atomics.store(ctl, C.STEP_US, Math.round((performance.now() - t0) * 1000));
      Atomics.add(ctl, C.SEQ, 1);
      Atomics.store(ctl, C.LAST_PAIRS, Atomics.load(ctl, C.PAIRS));
      // Hold 60 steps a second on a fixed schedule. Timed waits are only as fine as the OS timer
      // (about 15.6 ms on Windows, which halved the step rate), so sleep in 1 ms waits while there
      // is plenty of time left and spin for the rest.
      deadline += 1000 / 60;
      const now = performance.now();
      if (deadline < now - 50) deadline = now; // far behind: don't try to catch up
      while (deadline - performance.now() > 3) Atomics.wait(pace, 0, 0, 1);
      while (performance.now() < deadline) {
        // spin
      }
    }
  }
}
