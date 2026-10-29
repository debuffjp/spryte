// Runs the river's fluid off the main thread. Each step it posts the particles' start and end
// positions and speeds, packed as [x0, y0, x1, y1, speed] per particle, so the main thread can
// draw smoothly in between steps whatever rate the simulation manages.
import * as sim from "./river-sim.ts";

let count = 14_000;
let rocks: sim.Rock[] = [];
let running = false;

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.count !== undefined) count = m.count;
  if (m.rocks) rocks = m.rocks;
  if (m.reorder !== undefined) sim.state.reorder = m.reorder;
  if (!running) {
    running = true;
    loop();
  }
};

function loop(): void {
  const t0 = performance.now();
  sim.tick(count, rocks);
  const live = sim.state.live;
  const packed = new Float32Array(live * 5);
  for (let i = 0; i < live; i++) {
    const o = i * 5;
    packed[o] = sim.prevX[i];
    packed[o + 1] = sim.prevY[i];
    packed[o + 2] = sim.x[i];
    packed[o + 3] = sim.y[i];
    packed[o + 4] = Math.hypot(sim.vx[i], sim.vy[i]);
  }
  const ms = performance.now() - t0;
  self.postMessage({ packed, live, k: sim.state.k, pairs: sim.state.pairs, ms }, { transfer: [packed.buffer] });
  // Aim for 60 steps a second; a slower step just runs the next one straight away.
  setTimeout(loop, Math.max(0, 1000 / 60 - (performance.now() - t0)));
}
