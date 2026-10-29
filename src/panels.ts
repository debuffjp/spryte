import type { TextureSource } from "./backend.js";
import type { Color } from "./color.js";
import type { Draw, Frame } from "./draw.js";

/** Options for `nineSlice` and `tiled`. */
export interface PanelDrawOptions {
  /** Multiplied with the global alpha. */
  alpha?: number;
  /** Colour multiplier. Default white. */
  tint?: Color;
  /** 0..1 mix toward white. */
  flash?: number;
  /** Linear filtering. Default: the renderer's setting. */
  smooth?: boolean;
}

export interface TiledDrawOptions extends PanelDrawOptions {
  /** Scroll the pattern, in source pixels before `scale` (wraps). */
  offsetX?: number;
  offsetY?: number;
  /** Tile size multiplier. Default 1. */
  scale?: number;
}

const NONE: TiledDrawOptions = Object.freeze({});

/**
 * Stretch a frame over a `w × h` box at `x, y` (top-left) without stretching its corners: the classic UI panel.
 * `insets` are the corner sizes in source pixels, one number or `[left, top, right, bottom]`. Edges stretch,
 * the centre fills, and corners shrink evenly if the box is smaller than they are. Nine quads, any backend.
 *
 * ```ts
 * import { nineSlice } from "spryte";
 * nineSlice(draw, panel, 8, 8, 120, 48, 6);
 * ```
 */
export function nineSlice(
  draw: Draw,
  frame: Frame | TextureSource,
  x: number,
  y: number,
  w: number,
  h: number,
  insets: number | readonly [number, number, number, number],
  o: PanelDrawOptions = NONE,
): void {
  const f = "image" in frame ? frame : draw.wholeImage(frame);
  const [l, t, r, b] = typeof insets === "number" ? [insets, insets, insets, insets] : insets;
  // Corners keep their size unless they don't fit.
  const kx = Math.min(1, w / Math.max(l + r, 1e-9));
  const ky = Math.min(1, h / Math.max(t + b, 1e-9));
  const xs = [x, x + l * kx, x + w - r * kx, x + w];
  const ys = [y, y + t * ky, y + h - b * ky, y + h];
  const us = [f.x, f.x + l, f.x + f.w - r, f.x + f.w];
  const vs = [f.y, f.y + t, f.y + f.h - b, f.y + f.h];
  const color = draw.spriteColor(o);
  const smooth = o.smooth ?? draw.smooth;
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) {
      const pw = (xs[i + 1] as number) - (xs[i] as number);
      const ph = (ys[j + 1] as number) - (ys[j] as number);
      const sw = (us[i + 1] as number) - (us[i] as number);
      const sh = (vs[j + 1] as number) - (vs[j] as number);
      if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) continue;
      draw.local(xs[i] as number, ys[j] as number, pw, ph);
      if (!smooth) snapEdges(draw);
      draw.quads++;
      draw.backend.quad(draw.tmp, f.image, us[i] as number, vs[j] as number, sw, sh, color, o.flash ?? 0, smooth);
    }
}

/**
 * Fill a `w × h` box at `x, y` (top-left) with a frame repeated edge to edge: scrolling backgrounds, floors,
 * water. `offsetX/offsetY` scroll the pattern. Works on frames inside an atlas (no texture wrapping), one
 * quad per visible tile, on any backend.
 *
 * ```ts
 * import { tiled } from "spryte";
 * tiled(draw, water, 0, 120, 320, 60, { offsetX: t * 20 });
 * ```
 */
export function tiled(
  draw: Draw,
  frame: Frame | TextureSource,
  x: number,
  y: number,
  w: number,
  h: number,
  o: TiledDrawOptions = NONE,
): void {
  const f = "image" in frame ? frame : draw.wholeImage(frame);
  const k = o.scale ?? 1;
  const tw = f.w * k;
  const th = f.h * k;
  if (!(tw > 0 && th > 0 && w > 0 && h > 0)) return;
  const color = draw.spriteColor(o);
  const smooth = o.smooth ?? draw.smooth;
  const flash = o.flash ?? 0;
  const tiles = (Math.ceil(w / tw) + 1) * (Math.ceil(h / th) + 1);
  if (tiles > 1_000_000) throw new Error(`spryte: tiled() would draw ${tiles} tiles; use a larger frame or scale`);
  const ox = ((((o.offsetX ?? 0) * k) % tw) + tw) % tw;
  const oy = ((((o.offsetY ?? 0) * k) % th) + th) % th;
  for (let ty = y - oy; ty < y + h; ty += th) {
    const y0 = Math.max(ty, y);
    const y1 = Math.min(ty + th, y + h);
    if (y1 <= y0) continue;
    for (let tx = x - ox; tx < x + w; tx += tw) {
      const x0 = Math.max(tx, x);
      const x1 = Math.min(tx + tw, x + w);
      if (x1 <= x0) continue;
      draw.local(x0, y0, x1 - x0, y1 - y0);
      if (!smooth) snapEdges(draw);
      draw.quads++;
      draw.backend.quad(draw.tmp, f.image, f.x + (x0 - tx) / k, f.y + (y0 - ty) / k, (x1 - x0) / k, (y1 - y0) / k, color, flash, smooth);
    }
  }
}

/**
 * Pixel art: put an unrotated quad's edges on whole units, like `sprite()`. Neighbouring quads share edges,
 * so they round the same way and never gap or overlap.
 */
function snapEdges(draw: Draw): void {
  const t = draw.tmp;
  if (t[1] !== 0 || t[2] !== 0) return;
  const x0 = Math.round(t[4]);
  const y0 = Math.round(t[5]);
  t[0] = Math.round(t[4] + t[0]) - x0;
  t[3] = Math.round(t[5] + t[3]) - y0;
  t[4] = x0;
  t[5] = y0;
}
