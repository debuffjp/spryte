/** 2D affine matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (Canvas order). */
export type Matrix = [number, number, number, number, number, number];

export type BlendMode = "normal" | "add";

export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Raw access for advanced users. The backends are not interchangeable at this level. */
export type RawContext = { kind: "webgl2"; gl: WebGL2RenderingContext } | { kind: "2d"; ctx: CanvasRenderingContext2D };

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
  /** Begin a frame: clear to `clear` (0xRRGGBBAA) at the given logical size and backing scale. */
  begin(clear: number, width: number, height: number, scale: number): void;
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
  setBlend(mode: BlendMode): void;
  /**
   * Send drawing to `target` (null: the canvas). `clear` (0xRRGGBBAA) clears it first; null keeps what's there.
   * `width, height` are the logical size of the destination (the target's pixel size, or the canvas's logical size).
   */
  setTarget(target: RenderTarget | null, clear: number | null, width: number, height: number): void;
  /** Free a target's GPU or canvas storage. */
  disposeTarget(target: RenderTarget): void;
  /** Restrict drawing to a rectangle in backing-store pixels (top-left origin), or remove the clip. */
  setClip(rect: ClipRect | null): void;
  /** Submit everything queued this frame. */
  end(): void;
  resize(backingWidth: number, backingHeight: number): void;
  /** Drop cached GPU data for a source whose pixels changed. */
  invalidate(src: TextureSource): void;
  dispose(): void;
}
