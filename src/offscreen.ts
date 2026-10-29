import type { ClipRect } from "./backend.js";
import type { Draw } from "./draw.js";
import type { Shader } from "./shader.js";
import { RenderTarget } from "./target.js";

/** Two pooled targets per level of mask or filter nesting, kept between frames and remade when the size changes. */
const pools = new WeakMap<Draw, RenderTarget[]>();

/** @internal One level of offscreen drawing: the destination's size and two targets matching its pixels. */
export interface Offscreen {
  outer: RenderTarget | null;
  lw: number;
  lh: number;
  pw: number;
  ph: number;
  a: RenderTarget;
  b: RenderTarget;
  blend: Draw["blendMode"];
  alpha: number;
  clip: ClipRect | null;
}

/** @internal */
export function offscreen(draw: Draw): Offscreen {
  const outer = draw.target;
  const lw = draw.destW;
  const lh = draw.destH;
  const pw = outer ? outer.width : draw.backingW || Math.round(draw.viewW * draw.renderScale);
  const ph = outer ? outer.height : draw.backingH || Math.round(draw.viewH * draw.renderScale);
  const level = draw.maskDepth++;
  return {
    outer,
    lw,
    lh,
    pw,
    ph,
    a: pooled(draw, level * 2, pw, ph),
    b: pooled(draw, level * 2 + 1, pw, ph),
    blend: draw.blendMode,
    alpha: draw.alpha,
    clip: draw.clips.at(-1) ?? null,
  };
}

function pooled(draw: Draw, i: number, w: number, h: number): RenderTarget {
  let pool = pools.get(draw);
  if (!pool) {
    pool = [];
    pools.set(draw, pool);
  }
  const t = pool[i];
  if (t && t.width === w && t.height === h) return t;
  if (t) draw.backend.disposeTarget(t);
  const fresh = new RenderTarget(w, h);
  pool[i] = fresh;
  return fresh;
}

/** @internal Draw `fn` into `into` (cleared when `clear`), in the outer units and clip, starting from normal blending. */
export function pass(draw: Draw, o: Offscreen, into: RenderTarget, fn: () => void, clear: boolean): void {
  // The clip comes off before the switch: it belongs to the outer destination (a Canvas 2D clip is a save() on
  // its context, and a scissor would leave the target only partly cleared), and goes back on inside the target.
  if (o.clip) draw.backend.setClip(null);
  draw.target = into;
  draw.backend.setTarget(into, clear ? 0 : null, o.lw, o.lh);
  // Targets match the destination's pixels, so clips carry over as they are.
  if (o.clip) draw.backend.setClip(o.clip);
  draw.blend("normal");
  try {
    fn();
  } finally {
    if (o.clip) draw.backend.setClip(null);
  }
}

/** @internal Back to the outer destination, clip, alpha and blend. */
export function restore(draw: Draw, o: Offscreen): void {
  draw.target = o.outer;
  draw.backend.setTarget(o.outer, null, o.lw, o.lh);
  if (o.clip) draw.backend.setClip(o.clip);
  draw.maskDepth--;
  draw.alpha = o.alpha;
  draw.blend(o.blend);
}

/** @internal Draw a pooled target over the whole destination, 1:1 and untransformed, through `shader` (default none). 1:1 means `smooth` only matters to shaders sampling between texels. */
export function whole(draw: Draw, t: RenderTarget, o: Offscreen, shader: Shader | null = null, smooth = false): void {
  const outer = draw.shader;
  if (outer !== shader) draw.backend.setShader(shader);
  const m = draw.tmp;
  m[0] = o.lw;
  m[1] = 0;
  m[2] = 0;
  m[3] = o.lh;
  m[4] = 0;
  m[5] = 0;
  draw.quads++;
  draw.backend.quad(m, t, 0, 0, t.width, t.height, 0xffffffff, 0, smooth);
  if (outer !== shader) draw.backend.setShader(outer);
}
