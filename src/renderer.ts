import type { Backend } from "./backend.js";
import { Draw } from "./draw.js";
import { WebGL2Backend } from "./webgl2.js";

export interface RendererOptions {
  /** `auto` (default) uses WebGL2 and falls back to Canvas 2D; `webgl2` throws where it's unavailable. */
  backend?: "auto" | "webgl2" | "2d";
  /** Linear filtering for images by default. Pass false for pixel art. Default true. */
  smooth?: boolean;
}

/**
 * A `Draw` for a canvas: WebGL2 when available, otherwise the Canvas 2D fallback, loaded on demand so WebGL2
 * browsers (nearly all) never download it. Frames before the fallback finishes loading draw nothing.
 *
 * The canvas's backing size is yours to set; call `draw.resize(canvas.width, canvas.height)` after changing it.
 * Each frame: `draw.begin(clear, logicalWidth, logicalHeight, backingPixelsPerUnit)`, draw, `draw.end()`.
 * Call `draw.dispose()` when you're done with the canvas.
 */
export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): Draw {
  const choice = options.backend ?? "auto";
  if (choice !== "2d") {
    // alpha:false lets the compositor skip blending; desynchronized lowers input latency where supported.
    // preserveDrawingBuffer:false is fastest; captures render and read in the same task.
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      premultipliedAlpha: true,
      desynchronized: true,
      powerPreference: "high-performance",
    });
    if (gl) return new Draw(new WebGL2Backend(gl), options.smooth ?? true);
    if (choice === "webgl2")
      throw new Error('spryte: WebGL2 is unavailable in this browser (use backend: "auto" to fall back to Canvas 2D)');
  }
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) throw new Error("spryte: no WebGL2 or Canvas 2D context available (is the canvas already using another context type?)");
  const draw = new Draw(pending(ctx), options.smooth ?? true);
  draw.ready = import("./canvas2d.js").then(
    (m) => draw.setBackend(new m.Canvas2DBackend(ctx)),
    (cause) => {
      throw new Error("spryte: the Canvas 2D fallback failed to load", { cause });
    },
  );
  return draw;
}

/**
 * Stands in while the Canvas 2D fallback loads (a few milliseconds, on browsers without WebGL2): draws nothing,
 * but `raw` is already the real context.
 */
function pending(ctx: CanvasRenderingContext2D): Backend {
  const noop = () => {};
  return {
    kind: "2d",
    raw: { kind: "2d", ctx },
    begin: noop,
    quad: noop,
    setBlend: noop,
    setClip: noop,
    end: noop,
    resize: noop,
    invalidate: noop,
    dispose: noop,
  };
}
