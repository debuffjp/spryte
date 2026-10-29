/** 2D affine matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (Canvas order). */
export type Matrix = [number, number, number, number, number, number];

/**
 * How drawing combines with what's underneath. `add` brightens (glows, fire), `multiply` darkens (shadows,
 * tinted lighting), `screen` lightens softly, and `erase` cuts alpha out of what's there (holes in a render
 * target, masks). On a see-through target `multiply` follows the GPU formula, which hides drawing over fully
 * transparent pixels where Canvas 2D shows it.
 */
export type BlendMode = "normal" | "add" | "multiply" | "screen" | "erase";

export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Raw access for advanced users. The backends are not interchangeable at this level. */
export type RawContext = { kind: "webgl2"; gl: WebGL2RenderingContext } | { kind: "2d"; ctx: CanvasRenderingContext2D };

import type { CopySpec } from "./copies.js";
import type { Frame, SpriteDrawOptions } from "./draw.js";
import type { Shader } from "./shader.js";
import type { ShapeBuffer } from "./shapes.js";
import type { RenderTarget } from "./target.js";

/** Image sources the renderer can draw. Textures are cached per source object. */
export type TextureSource = HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap | RenderTarget;

/**
 * What a rendering backend implements. Everything is expressed as quads: a transform that maps the
 * unit square onto logical space, an optional source rectangle, and an RGBA colour (tint).
 * @internal
 */
export interface Backend {
  readonly kind: "webgl2" | "2d";
  readonly raw: RawContext;
  /** True while the GPU context is lost, where that can happen (WebGL2). */
  readonly contextLost?: boolean;
  /** GPU draw calls submitted so far this frame, where the backend batches (WebGL2). */
  readonly drawCalls?: number;
  /** Begin a frame: clear to `clear` (0xRRGGBBAA; null keeps what's there) at the given logical size and backing scale. */
  begin(clear: number | null, width: number, height: number, scale: number): void;
  /**
   * Draw the unit square transformed by `m`. `src` null draws solid `color`.
   * `sx, sy, sw, sh` is the source rect in source pixels (ignored when `src` is null). `flash` (0..1) mixes the texture toward white.
   * `smooth` selects linear filtering for this source.
   */
  quad(
    m: Matrix,
    src: TextureSource | null,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    color: number,
    flash: number,
    smooth: boolean,
  ): void;
  /**
   * Many copies of one quad: `t` maps the unit square for a copy at (0, 0); copy i is moved by
   * (positions[2i], positions[2i+1]) through `m`'s linear part. `snap` rounds each copy to whole pixels.
   */
  quads(
    t: Matrix,
    m: Matrix,
    positions: ArrayLike<number>,
    count: number,
    src: TextureSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    color: number,
    flash: number,
    smooth: boolean,
    snap: boolean,
  ): void;
  /**
   * `draw.sprite` for backends that do the transform algebra themselves: frame `f` at `x, y` under `m`, with `o`'s
   * origin, scale, flips, rotation and flash, in colour `color`. `ver` changes whenever `m` does, so a backend can
   * tell the transform is unchanged without comparing it. Unrotated pixel art (`smooth` false) must land on whole
   * pixels, as `Draw` rounds it for `quad`. Without it, `Draw` calls `quad`.
   */
  sprite?(ver: number, m: Matrix, f: Frame, x: number, y: number, o: SpriteDrawOptions, color: number, smooth: boolean): void;
  /** Copies of one frame with per-copy scale, rotation or colour (`draw.sprites` with `each`). */
  copies(spec: CopySpec): void;
  /**
   * Fill (`width` 0) or stroke a path of `n` points (x0, y0, x1, y1, …) in the units `m` maps to logical space.
   * `aa` is one device pixel in those units, for edge antialiasing where the backend does its own. The
   * tessellator comes from the shape functions, so it's only in apps that draw shapes.
   */
  path(
    m: Matrix,
    points: ArrayLike<number>,
    n: number,
    closed: boolean,
    width: number,
    color: number,
    aa: number,
    tessellator: new () => ShapeBuffer,
  ): void;
  /** `mask` (internal, for `mask()`) keeps what's there in proportion to the source's alpha. */
  setBlend(mode: BlendMode | "mask"): void;
  /**
   * Send drawing to `target` (null: the canvas). `clear` (0xRRGGBBAA) clears it first; null keeps what's there.
   * `width, height` are the logical size of the destination: the canvas's logical size, or for a target its pixel
   * size (`into`) or the canvas's logical size again (`mask`, whose targets match the canvas's backing pixels).
   */
  setTarget(target: RenderTarget | null, clear: number | null, width: number, height: number): void;
  /** Draw subsequent quads with a custom fragment effect (null: the default). */
  setShader(shader: Shader | null): void;
  /** Canvas 2D only: a CSS filter (`"none"` to clear) for subsequent draws. Its presence selects CSS filters in `filter()`. */
  setFilter?(css: string): void;
  /** Free a target's GPU or canvas storage. */
  disposeTarget(target: RenderTarget): void;
  /** Restrict drawing to a rectangle in backing-store pixels (top-left origin), or remove the clip. */
  setClip(rect: ClipRect | null): void;
  /** Submit everything queued this frame. */
  end(): void;
  resize(backingWidth: number, backingHeight: number): void;
  /** Drop cached GPU data for a source whose pixels changed. */
  invalidate(src: TextureSource): void;
  /**
   * Copy `w × h` pixels of `from` into `dst` at (`x`, `y`), where `dst` (a canvas this backend may hold as a
   * texture) has already been updated the same way. Lets a texture atlas upload one new region instead of
   * re-uploading the whole image. Backends that draw straight from the canvas don't need it.
   */
  update?(dst: TextureSource, x: number, y: number, from: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): void;
  dispose(): void;
}
