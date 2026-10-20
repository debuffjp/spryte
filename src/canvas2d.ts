import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import { rgbaToCss } from "./color.js";
import { type CopySpec, copyAt } from "./copies.js";
import type { Shader } from "./shader.js";
import { RenderTarget } from "./target.js";

type Surface = HTMLCanvasElement | OffscreenCanvas;

/**
 * Canvas 2D fallback for the `draw` API. Same output for solid shapes, sprites, text and alpha.
 * Canvas 2D has no per-draw tint, so tinted or flashed textures (text, bitmap fonts, `tint`, `flash`) are
 * recoloured once on the CPU (getImageData) and cached per source, frame, colour and flash; render target
 * sources are recoloured on every draw. Untinted draws skip all of this. Anti-aliased edges of rotated or
 * fractionally placed sprites can differ slightly from WebGL2: that's Canvas 2D's own rasteriser.
 */
export class Canvas2DBackend implements Backend {
  readonly kind = "2d" as const;
  readonly raw: RawContext;
  /** Where drawing goes: the canvas's context, or a render target's while inside `draw.into`. */
  private ctx: CanvasRenderingContext2D;
  private readonly screen: CanvasRenderingContext2D;
  private screenScale = 1;
  private readonly surfaces = new WeakMap<RenderTarget, Surface>();
  private target: RenderTarget | null = null;
  private warnedShader = false;
  private scale = 1;
  private smoothing: boolean | undefined;
  private scratch: HTMLCanvasElement | OffscreenCanvas | undefined;
  /** Recoloured frames per source, keyed by rect, tint and flash. */
  private shades = new WeakMap<object, Map<string, Surface>>();
  private clipped = false;
  private blendMode: BlendMode = "normal";

  constructor(ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.screen = ctx;
    this.raw = { kind: "2d", ctx };
  }

  begin(clear: number, width: number, height: number, scale: number): void {
    this.ctx = this.screen;
    this.target = null;
    this.scale = scale;
    this.screenScale = scale;
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
    if (src !== null && src === this.target) throw new Error("spryte: can't draw a render target into itself");
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
    const image = src instanceof RenderTarget ? this.surface(src) : src;
    ctx.globalAlpha = (color & 0xff) / 255;
    const rgb = color >>> 8;
    if (rgb === 0xffffff && !(flash > 0)) ctx.drawImage(image, sx, sy, sw, sh, 0, 0, 1, 1);
    else ctx.drawImage(this.shaded(image, src instanceof RenderTarget, sx, sy, sw, sh, rgb, flash), 0, 0, sw, sh, 0, 0, 1, 1);
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

  copies(c: CopySpec): void {
    const q: Matrix = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < c.count; i++) {
      const color = copyAt(c, i, q);
      this.quad(q, c.src, c.sx, c.sy, c.sw, c.sh, color, c.flash, c.smooth);
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
      // restore() also reset imageSmoothingEnabled: forget the cached value so the next draw sets it.
      this.smoothing = undefined;
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

  invalidate(src: TextureSource): void {
    this.shades.delete(src);
  }

  dispose(): void {}

  setTarget(target: RenderTarget | null, clear: number | null, _width: number, _height: number): void {
    this.ctx = target ? (this.surface(target).getContext("2d") as CanvasRenderingContext2D) : this.screen;
    this.target = target;
    // Targets are sized in pixels; the canvas in logical units at its backing scale.
    this.scale = target ? 1 : this.screenScale;
    this.smoothing = undefined;
    this.setBlend(this.blendMode);
    if (target && clear !== null) {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, target.width, target.height);
      if ((clear & 0xff) !== 0) {
        ctx.fillStyle = rgbaToCss(clear);
        ctx.fillRect(0, 0, target.width, target.height);
      }
    }
  }

  setShader(shader: Shader | null): void {
    if (shader && !this.warnedShader) {
      this.warnedShader = true;
      console.warn("spryte: custom shaders need WebGL2; the Canvas 2D fallback draws without them");
    }
  }

  disposeTarget(target: RenderTarget): void {
    if (target === this.target) throw new Error("spryte: can't dispose a render target while drawing into it");
    const surface = this.surfaces.get(target);
    if (!surface) return;
    // Release the pixels now rather than whenever the canvas is collected.
    surface.width = 0;
    surface.height = 0;
    this.surfaces.delete(target);
  }

  private surface(target: RenderTarget): Surface {
    let surface = this.surfaces.get(target);
    if (!surface) {
      surface =
        typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(target.width, target.height) : document.createElement("canvas");
      surface.width = target.width;
      surface.height = target.height;
      this.surfaces.set(target, surface);
    }
    return surface;
  }

  /**
   * The source region with `rgb` multiplied in and mixed toward white by `flash`, alpha kept: the WebGL2
   * shader's `mix(texel * tint, vec3(texel.a), flash)` in straight alpha. Canvas composite modes can't do this
   * exactly on partly transparent pixels, so it's done per pixel and cached (render targets change, so not those).
   */
  private shaded(src: CanvasImageSource, live: boolean, x: number, y: number, w: number, h: number, rgb: number, flash: number): Surface {
    const f = Math.round(Math.min(1, Math.max(0, flash || 0)) * 255);
    const key = `${x},${y},${w},${h},${rgb},${f}`;
    let cache = live ? undefined : this.shades.get(src);
    const hit = cache?.get(key);
    if (hit) return hit;
    const pw = Math.ceil(w);
    const ph = Math.ceil(h);
    const out: Surface = live ? this.scratchCanvas(pw, ph) : newSurface(pw, ph);
    const octx = out.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!octx) return out;
    octx.globalCompositeOperation = "copy";
    octx.imageSmoothingEnabled = false;
    octx.drawImage(src, x, y, w, h, 0, 0, w, h);
    const data = octx.getImageData(0, 0, pw, ph);
    const d = data.data;
    const r = (rgb >>> 16) & 0xff;
    const g = (rgb >>> 8) & 0xff;
    const b = rgb & 0xff;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = mixWhite(((d[i] as number) * r) / 255, f);
      d[i + 1] = mixWhite(((d[i + 1] as number) * g) / 255, f);
      d[i + 2] = mixWhite(((d[i + 2] as number) * b) / 255, f);
    }
    octx.putImageData(data, 0, 0);
    if (!live) {
      if (!cache) {
        cache = new Map();
        this.shades.set(src, cache);
      }
      // Animated tints would grow this forever; start over rather than track recency.
      if (cache.size >= 256) cache.clear();
      cache.set(key, out);
    }
    return out;
  }

  private scratchCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
    if (!this.scratch) this.scratch = newSurface(w, h);
    if (this.scratch.width < w) this.scratch.width = w;
    if (this.scratch.height < h) this.scratch.height = h;
    return this.scratch;
  }
}

function newSurface(w: number, h: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function mixWhite(c: number, f: number): number {
  return Math.round(c + ((255 - c) * f) / 255);
}
