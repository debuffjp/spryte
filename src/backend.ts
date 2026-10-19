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

/** Image sources the renderer can draw. Textures are cached per source object. */
export type TextureSource = HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

/**
 * What a rendering backend implements. Everything is expressed as quads: a transform that maps the
 * unit square onto logical space, an optional source rectangle, and an RGBA colour (tint).
 * @internal
 */
export interface Backend {
  readonly kind: "webgl2" | "2d";
  readonly raw: RawContext;
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
  setBlend(mode: BlendMode): void;
  /** Restrict drawing to a rectangle in backing-store pixels (top-left origin), or remove the clip. */
  setClip(rect: ClipRect | null): void;
  /** Submit everything queued this frame. */
  end(): void;
  resize(backingWidth: number, backingHeight: number): void;
  /** Drop cached GPU data for a source whose pixels changed. */
  invalidate(src: TextureSource): void;
  dispose(): void;
}
