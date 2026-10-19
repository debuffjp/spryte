import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import { rgbaToCss } from "./color.js";

/**
 * Canvas 2D fallback for the `draw` API. Same output for solid shapes, sprites, text and alpha.
 * Canvas 2D has no per-draw tint, so tinted textures (text, bitmap fonts, `tint`) go through a scratch
 * canvas: slower than WebGL2, but only when a tint other than white is asked for.
 */
export class Canvas2DBackend implements Backend {
  readonly kind = "2d" as const;
  readonly raw: RawContext;
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;
  private smoothing: boolean | undefined;
  private scratch: HTMLCanvasElement | OffscreenCanvas | undefined;
  private clipped = false;
  private blendMode: BlendMode = "normal";

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.raw = { kind: "2d", ctx };
  }

  begin(clear: number, width: number, height: number, scale: number): void {
    this.scale = scale;
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = rgbaToCss(clear);
    ctx.fillRect(0, 0, width, height);
  }

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
  ): void {
    const ctx = this.ctx;
    const s = this.scale;
    ctx.setTransform(m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s);
    if (!src) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = rgbaToCss(color);
      ctx.fillRect(0, 0, 1, 1);
      return;
    }
    if (this.smoothing !== smooth) {
      ctx.imageSmoothingEnabled = smooth;
      this.smoothing = smooth;
    }
    ctx.globalAlpha = (color & 0xff) / 255;
    if (color >>> 8 === 0xffffff) ctx.drawImage(src, sx, sy, sw, sh, 0, 0, 1, 1);
    else ctx.drawImage(this.tinted(src, sx, sy, sw, sh, color), 0, 0, sw, sh, 0, 0, 1, 1);
    if (flash > 0) {
      ctx.globalAlpha *= Math.min(1, flash);
      ctx.drawImage(this.whiteSilhouette(src, sx, sy, sw, sh), 0, 0, sw, sh, 0, 0, 1, 1);
    }
  }

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
  ): void {
    const q: Matrix = [t[0], t[1], t[2], t[3], 0, 0];
    for (let i = 0; i < count; i++) {
      const x = positions[i * 2] as number;
      const y = positions[i * 2 + 1] as number;
      q[4] = t[4] + m[0] * x + m[2] * y;
      q[5] = t[5] + m[1] * x + m[3] * y;
      if (snap) {
        q[4] = Math.round(q[4]);
        q[5] = Math.round(q[5]);
      }
      this.quad(q, src, sx, sy, sw, sh, color, flash, smooth);
    }
  }

  setBlend(mode: BlendMode): void {
    this.blendMode = mode;
    this.ctx.globalCompositeOperation = mode === "add" ? "lighter" : "source-over";
  }

  setClip(rect: ClipRect | null): void {
    const ctx = this.ctx;
    // Canvas clips only shrink, so each change restores to the unclipped state first.
    if (this.clipped) {
      ctx.restore();
      this.clipped = false;
      this.setBlend(this.blendMode);
    }
    if (!rect) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    this.clipped = true;
  }

  end(): void {
    this.setClip(null);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
  }

  resize(): void {
    // Canvas resize resets context state; it's reapplied in begin().
    this.smoothing = undefined;
  }

  invalidate(): void {
    // Canvas 2D reads sources directly; nothing is cached.
  }

  dispose(): void {}

  /** The source region multiplied by `color`'s RGB, keeping the source's alpha. */
  private tinted(src: TextureSource, x: number, y: number, w: number, h: number, color: number): HTMLCanvasElement | OffscreenCanvas {
    const scratch = this.scratchCanvas(w, h);
    const sctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
    if (!sctx) return scratch;
    sctx.clearRect(0, 0, w, h);
    sctx.globalCompositeOperation = "source-over";
    sctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    sctx.globalCompositeOperation = "multiply";
    sctx.fillStyle = rgbaToCss(color | 0xff);
    sctx.fillRect(0, 0, w, h);
    // multiply filled the transparent pixels too; cut back to the source's shape.
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    sctx.globalCompositeOperation = "source-over";
    return scratch;
  }

  private scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
    if (!this.scratch) this.scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
    if (this.scratch.width < w) this.scratch.width = w;
    if (this.scratch.height < h) this.scratch.height = h;
    return this.scratch;
  }

  private whiteSilhouette(src: TextureSource, x: number, y: number, w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
    const scratch = this.scratchCanvas(w, h);
    const sctx = scratch.getContext("2d") as CanvasRenderingContext2D | null;
    if (!sctx) return scratch;
    sctx.clearRect(0, 0, w, h);
    sctx.globalCompositeOperation = "source-over";
    sctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    sctx.globalCompositeOperation = "source-in";
    sctx.fillStyle = "#fff";
    sctx.fillRect(0, 0, w, h);
    return scratch;
  }
}
