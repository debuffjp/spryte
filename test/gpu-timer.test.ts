import { describe, expect, it } from "vitest";
import type { Draw } from "../src/draw.js";
import { gpuTimer } from "../src/gpu-timer.js";

const TIME_ELAPSED = 0x88bf;
const DISJOINT = 0x8fbb;
const CURRENT_QUERY = 0x8865;
const AVAILABLE = 0x8867;
const RESULT = 0x8866;

/** A WebGL2 context with the timer extension, where tests decide when each query's result is ready. */
function fakeGL({ extension = true } = {}) {
  const ready = new Map<object, number>();
  const state = { disjoint: false, hostQuery: null as object | null, begun: 0, deleted: 0 };
  let current: object | null = null;
  const gl = {
    CURRENT_QUERY,
    QUERY_RESULT_AVAILABLE: AVAILABLE,
    QUERY_RESULT: RESULT,
    getExtension: () => (extension ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT } : null),
    createQuery: () => ({}),
    deleteQuery: () => state.deleted++,
    beginQuery: (_t: number, q: object) => {
      if (current) throw new Error("INVALID_OPERATION: a query is already active");
      current = q;
      state.begun++;
    },
    endQuery: () => {
      current = null;
    },
    getQuery: () => state.hostQuery ?? current,
    getParameter: (p: number) => (p === DISJOINT ? state.disjoint : null),
    getQueryParameter: (q: object, p: number) => (p === AVAILABLE ? ready.has(q) : ready.get(q)),
  };
  const queries: object[] = [];
  const realBegin = gl.beginQuery;
  gl.beginQuery = (t, q) => {
    queries.push(q);
    realBegin(t, q);
  };
  /** Mark the n-th query ever begun as finished, taking `ms` milliseconds. */
  const finish = (n: number, ms: number) => ready.set(queries[n] as object, ms * 1e6);
  const draw = { raw: { kind: "webgl2", gl }, contextLost: false } as unknown as Draw;
  return { draw, state, finish };
}

const frame = (t: ReturnType<typeof gpuTimer>) => {
  t.begin();
  t.end();
};

describe("gpuTimer", () => {
  it("is unsupported without the extension or on Canvas 2D, and never reports 0", () => {
    const none = gpuTimer(fakeGL({ extension: false }).draw);
    frame(none);
    expect(none.supported).toBe(false);
    expect(none.ms).toBeUndefined();
    const canvas = gpuTimer({ raw: { kind: "2d", ctx: {} } } as unknown as Draw);
    expect(canvas.supported).toBe(false);
  });

  it("reports results frames later, smoothed, without blocking", () => {
    const { draw, finish } = fakeGL();
    const t = gpuTimer(draw);
    frame(t);
    frame(t);
    expect(t.ms).toBeUndefined();
    finish(0, 2);
    frame(t);
    expect(t.ms).toBe(2);
    finish(1, 4);
    frame(t);
    expect(t.ms).toBeCloseTo(2.2);
  });

  it("drops pending results after a disjoint event", () => {
    const { draw, state, finish } = fakeGL();
    const t = gpuTimer(draw);
    frame(t);
    finish(0, 3);
    state.disjoint = true;
    frame(t);
    expect(t.ms).toBeUndefined();
  });

  it("skips the frame when a host engine already has a timer query open", () => {
    const { draw, state } = fakeGL();
    const t = gpuTimer(draw);
    state.hostQuery = {};
    expect(() => frame(t)).not.toThrow();
    expect(state.begun).toBe(0);
  });

  it("keeps at most a few results waiting when the GPU never answers", () => {
    const { draw, state } = fakeGL();
    const t = gpuTimer(draw);
    for (let i = 0; i < 100; i++) frame(t);
    t.dispose();
    // Queries are recycled once dropped, so only a handful were ever created and deleted.
    expect(state.deleted).toBeLessThanOrEqual(10);
  });
});
