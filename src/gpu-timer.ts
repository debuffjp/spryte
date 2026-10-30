import type { Draw } from "./draw.js";

/** GPU time for the work submitted between `begin()` and `end()`, read a few frames later. See `gpuTimer`. */
export interface GpuTimer {
  /** Whether this browser and backend can time the GPU (WebGL2 with `EXT_disjoint_timer_query_webgl2`). */
  readonly supported: boolean;
  /**
   * Smoothed GPU milliseconds per `begin()`/`end()` pair, or `undefined` until a result arrives, when timing
   * isn't supported, and after a context loss or a GPU timing glitch (a "disjoint" event) until new results come.
   */
  readonly ms: number | undefined;
  /** Start timing. Call before `draw.begin()` to time the whole frame. */
  begin(): void;
  /** Stop timing, and collect any results the GPU has finished. Call after `draw.end()`. */
  end(): void;
  /** Free the GPU queries. */
  dispose(): void;
}

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Results waiting longer than this many frames are dropped, so a stalled GPU can't grow the pool. */
const PENDING = 8;

/**
 * Measure how long the GPU spends on what spryte draws, to tell whether a slow frame is GPU-bound (draw
 * less, or smaller) or CPU-bound (simulate less). WebGL2 only, and only where the browser exposes
 * `EXT_disjoint_timer_query_webgl2`: in practice Chromium on desktop; Safari, Firefox and Android Chrome don't.
 *
 * ```ts
 * const gpu = gpuTimer(draw);
 * // each frame:
 * gpu.begin();
 * draw.begin("#000", w, h, dpr);
 * // ...draw...
 * draw.end();
 * gpu.end();
 * hud.text = gpu.ms === undefined ? "GPU: n/a" : `GPU ${gpu.ms.toFixed(1)} ms`;
 * ```
 *
 * Results arrive a few frames late and never block. Only one GPU timer can run at a time: inside another
 * engine (`createSharedRenderer`) that already times its frame, or alongside a profiler, the frame is skipped.
 */
export function gpuTimer(draw: Draw): GpuTimer {
  const raw = draw.raw;
  const gl = raw.kind === "webgl2" ? raw.gl : null;
  const ext = gl?.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null | undefined;
  if (!gl || !ext) return { supported: false, ms: undefined, begin() {}, end() {}, dispose() {} };

  const free: WebGLQuery[] = [];
  const pending: WebGLQuery[] = [];
  let active: WebGLQuery | null = null;
  let ms: number | undefined;
  let lost = false;

  const reset = () => {
    // Queries from before a context loss are dead: forget them rather than delete them.
    free.length = 0;
    pending.length = 0;
    active = null;
    ms = undefined;
  };

  return {
    supported: true,
    get ms() {
      return ms;
    },
    begin() {
      if (draw.contextLost) {
        lost = true;
        return;
      }
      if (lost) {
        lost = false;
        reset();
      }
      // Beginning a second TIME_ELAPSED query is an error: skip the frame if a host engine or profiler has one open.
      if (active || gl.getQuery(ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return;
      const q = free.pop() ?? gl.createQuery();
      if (!q) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      active = q;
    },
    end() {
      if (!active || draw.contextLost) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
      // A disjoint event (power state change, another app on the GPU) makes every pending result meaningless.
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        free.push(...pending.splice(0));
        ms = undefined;
        return;
      }
      while (pending.length) {
        const q = pending[0] as WebGLQuery;
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const took = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        ms = ms === undefined ? took : ms + (took - ms) * 0.1;
        free.push(pending.shift() as WebGLQuery);
      }
      if (pending.length > PENDING) free.push(pending.shift() as WebGLQuery);
    },
    dispose() {
      if (active) gl.endQuery(ext.TIME_ELAPSED_EXT);
      if (!draw.contextLost) for (const q of [...free, ...pending, ...(active ? [active] : [])]) gl.deleteQuery(q);
      reset();
    },
  };
}
