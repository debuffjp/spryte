import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import type { BitmapFont } from "./bitmap-font.js";
import { type Color, toRGBA } from "./color.js";
import { RenderTarget } from "./target.js";

/** A rectangular region of an image, in source pixels. */
export interface Frame {
  image: TextureSource;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteDrawOptions {
  /** Anchor as a fraction of the frame size. Default [0.5, 0.5] (centre). */
  origin?: readonly [number, number];
  scaleX?: number;
  scaleY?: number;
  /** Radians. */
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  /** Multiplied with the global alpha. */
  alpha?: number;
  /** Colour multiplier. Default white. */
  tint?: Color;
  /** 0..1 mix toward white, e.g. hit flashes. */
  flash?: number;
  /** Linear filtering for this sprite. Default: the game's setting (off when `pixelArt`). */
  smooth?: boolean;
}

export interface TextDrawOptions {
  /** A `BitmapFont`, or a CSS font such as "16px monospace". Default: `draw.font`. */
  font?: string | BitmapFont | undefined;
  color?: Color;
  align?: "left" | "center" | "right";
  baseline?: "top" | "middle" | "bottom";
  alpha?: number;
}

const NO_OPTIONS: SpriteDrawOptions = Object.freeze({});
const WHITE = 0xffffffff;

/**
 * Immediate-mode drawing in logical units, the same API on WebGL2 and Canvas 2D (ADR 0007).
 * Everything batches automatically; call order is draw order.
 */
export class Draw {
  /** Global alpha multiplier for subsequent draws. */
  alpha = 1;
  /**
   * Font for `text()` and `measure()` when none is given: a CSS font, a `BitmapFont`, or a function returning
   * one (called on first use, so a font built from a canvas costs nothing until text is drawn).
   */
  font: string | BitmapFont | (() => string | BitmapFont) = "16px sans-serif";
  /** Quads (sprites, rects, glyph runs…) submitted this frame. Reset each frame; for diagnostics. */
  quads = 0;
  /** Preallocated transform stack: push/pop copy six numbers and never allocate. */
  private readonly stack: Matrix[] = [];
  private depth = 0;
  private readonly m: Matrix = [1, 0, 0, 1, 0, 0];
  private readonly frames = new WeakMap<TextureSource, Frame>();
  private lastImage: TextureSource | null = null;
  private lastFrame: Frame | undefined;
  private readonly clips: ClipRect[] = [];
  /** The render target being drawn into, or null for the canvas. */
  private target: RenderTarget | null = null;
  /** The canvas's logical size this frame, to switch back to after `into()`. */
  private viewW = 1;
  private viewH = 1;
  private readonly tmp: Matrix = [1, 0, 0, 1, 0, 0];
  private readonly textCache = new TextCache();
  private circleTexture: HTMLCanvasElement | OffscreenCanvas | undefined;

  private backingW = 0;
  private backingH = 0;

  /** @internal */
  constructor(
    private backend: Backend,
    /** Default filtering for images (false for pixel art). */
    public smooth: boolean,
  ) {}

  /** Which backend is active. */
  get kind(): "webgl2" | "2d" {
    return this.backend.kind;
  }

  /** Draw calls this frame: batched GPU calls on WebGL2, one per quad on Canvas 2D. */
  get drawCalls(): number {
    return this.backend.drawCalls ?? this.quads;
  }

  /**
   * Resolves once the backend can draw. Immediate on WebGL2; on the Canvas 2D fallback, once its chunk has
   * loaded (frames before that draw nothing). Rejects if the fallback fails to load.
   */
  ready: Promise<void> = Promise.resolve();

  /** Raw `WebGL2RenderingContext` or `CanvasRenderingContext2D`. Mixing raw calls with `draw` calls requires care. */
  get raw(): RawContext {
    return this.backend.raw;
  }

  // ---- transform stack -------------------------------------------------------------------

  push(): void {
    let slot = this.stack[this.depth];
    if (!slot) {
      slot = [1, 0, 0, 1, 0, 0];
      this.stack[this.depth] = slot;
    }
    copy(this.m, slot);
    this.depth++;
  }

  pop(): void {
    if (this.depth === 0) throw new Error("draw.pop() without a matching push()");
    this.depth--;
    copy(this.stack[this.depth] as Matrix, this.m);
  }

  translate(x: number, y: number): void {
    const m = this.m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
  }

  scale(x: number, y = x): void {
    const m = this.m;
    m[0] *= x;
    m[1] *= x;
    m[2] *= y;
    m[3] *= y;
  }

  rotate(radians: number): void {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const [a, b, cc, d] = this.m;
    this.m[0] = a * c + cc * s;
    this.m[1] = b * c + d * s;
    this.m[2] = cc * c - a * s;
    this.m[3] = d * c - b * s;
  }

  /**
   * Run `fn` with drawing restricted to a rectangle (in current units), then restore. Nested clips
   * intersect. Clips are axis-aligned on screen: under rotation the rectangle's screen bounds are used.
   */
  clip(x: number, y: number, w: number, h: number, fn: () => void): void {
    const m = this.m;
    const s = this.renderScale;
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const [px, py] of [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h],
    ] as const) {
      const sx = (m[0] * px + m[2] * py + m[4]) * s;
      const sy = (m[1] * px + m[3] * py + m[5]) * s;
      x0 = Math.min(x0, sx);
      y0 = Math.min(y0, sy);
      x1 = Math.max(x1, sx);
      y1 = Math.max(y1, sy);
    }
    let rect: ClipRect = {
      x: Math.round(x0),
      y: Math.round(y0),
      w: Math.max(0, Math.round(x1) - Math.round(x0)),
      h: Math.max(0, Math.round(y1) - Math.round(y0)),
    };
    const outer = this.clips.at(-1);
    if (outer) rect = intersect(rect, outer);
    this.clips.push(rect);
    this.backend.setClip(rect);
    try {
      fn();
    } finally {
      this.clips.pop();
      this.backend.setClip(this.clips.at(-1) ?? null);
    }
  }

  /** Run `fn` with the camera's view applied, then restore. */
  withCamera(camera: { view(): Matrix }, fn: () => void): void {
    this.push();
    const [a, b, c, d, e, f] = camera.view();
    const m = this.m;
    const [ma, mb, mc, md, me, mf] = m;
    m[0] = ma * a + mc * b;
    m[1] = mb * a + md * b;
    m[2] = ma * c + mc * d;
    m[3] = mb * c + md * d;
    m[4] = ma * e + mc * f + me;
    m[5] = mb * e + md * f + mf;
    try {
      fn();
    } finally {
      this.pop();
    }
  }

  // ---- drawing ---------------------------------------------------------------------------

  blend(mode: BlendMode): void {
    this.backend.setBlend(mode);
  }

  rect(x: number, y: number, w: number, h: number, color: Color): void {
    this.local(x, y, w, h);
    this.quads++;
    this.backend.quad(this.tmp, null, 0, 0, 1, 1, this.withAlpha(toRGBA(color), 1), 0, false);
  }

  /** Filled circle (antialiased). */
  circle(x: number, y: number, radius: number, color: Color): void {
    this.local(x - radius, y - radius, radius * 2, radius * 2);
    const tex = this.circle64();
    this.quads++;
    this.backend.quad(this.tmp, tex, 0, 0, 64, 64, this.withAlpha(toRGBA(color), 1), 0, true);
  }

  line(x1: number, y1: number, x2: number, y2: number, width: number, color: Color): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    this.push();
    this.translate(x1, y1);
    this.rotate(Math.atan2(dy, dx));
    this.rect(0, -width / 2, len, width, color);
    this.pop();
  }

  /** Draw an image frame (or a whole image) at `x, y`, anchored by `origin`. Allocation-free hot path. */
  sprite(frame: Frame | TextureSource, x: number, y: number, o: SpriteDrawOptions = NO_OPTIONS): void {
    const f = this.place(frame, x, y, o);
    const t = this.tmp;
    const smooth = o.smooth ?? this.smooth;
    if (!smooth && t[1] === 0 && t[2] === 0) {
      // Pixel art: put unrotated sprites on whole pixels. Nearest sampling at fractional positions
      // makes edges gain and lose a pixel from frame to frame, which reads as flicker.
      t[4] = Math.round(t[4]);
      t[5] = Math.round(t[5]);
    }
    this.quads++;
    this.backend.quad(t, f.image, f.x, f.y, f.w, f.h, this.spriteColor(o), o.flash ?? 0, smooth);
  }

  /**
   * Draw one image frame at many positions in a single call: particles, bullets, swarms, starfields.
   * `positions` holds x, y pairs (a `Float32Array` you reuse is ideal); `count` defaults to all of them.
   * Every copy shares `options` (rotation, scale, tint, alpha…), so per-copy work is just the position.
   * Much faster than calling `sprite()` in a loop, and allocation-free.
   *
   * ```ts
   * const pos = new Float32Array(2 * MAX);
   * // ...update pos...
   * draw.sprites(spark, pos, live, { tint: "#ffd36b", alpha: 0.8 });
   * ```
   */
  sprites(
    frame: Frame | TextureSource,
    positions: ArrayLike<number>,
    count = positions.length >> 1,
    o: SpriteDrawOptions = NO_OPTIONS,
  ): void {
    if (count <= 0) return;
    const f = this.place(frame, 0, 0, o);
    const t = this.tmp;
    const smooth = o.smooth ?? this.smooth;
    // Snapped per copy, like sprite().
    const snap = !smooth && t[1] === 0 && t[2] === 0;
    this.quads += count;
    this.backend.quads(t, this.m, positions, count, f.image, f.x, f.y, f.w, f.h, this.spriteColor(o), o.flash ?? 0, smooth, snap);
  }

  /** tmp = M · T(x, y) · R(rotation) · S(sx, sy) · T(ox, oy) · S(w, h), expanded by hand. Returns the frame. */
  private place(frame: Frame | TextureSource, x: number, y: number, o: SpriteDrawOptions): Frame {
    // Check the repeat-image cache before `in`: on a DOM image, `in` walks a long prototype chain per call.
    const f = frame === this.lastImage && this.lastFrame ? this.lastFrame : "image" in frame ? frame : this.wholeImage(frame);
    const origin = o.origin;
    const ox = -(origin ? origin[0] : 0.5) * f.w;
    const oy = -(origin ? origin[1] : 0.5) * f.h;
    const sx = (o.scaleX ?? 1) * (o.flipX ? -1 : 1);
    const sy = (o.scaleY ?? 1) * (o.flipY ? -1 : 1);
    const m = this.m;
    let a = sx;
    let b = 0;
    let c = 0;
    let d = sy;
    const r = o.rotation;
    if (r) {
      const cos = Math.cos(r);
      const sin = Math.sin(r);
      a = cos * sx;
      b = sin * sx;
      c = -sin * sy;
      d = cos * sy;
    }
    const lx = a * ox + c * oy + x;
    const ly = b * ox + d * oy + y;
    const t = this.tmp;
    t[0] = (m[0] * a + m[2] * b) * f.w;
    t[1] = (m[1] * a + m[3] * b) * f.w;
    t[2] = (m[0] * c + m[2] * d) * f.h;
    t[3] = (m[1] * c + m[3] * d) * f.h;
    t[4] = m[0] * lx + m[2] * ly + m[4];
    t[5] = m[1] * lx + m[3] * ly + m[5];
    return f;
  }

  private spriteColor(o: SpriteDrawOptions): number {
    const tint = o.tint === undefined ? WHITE : toRGBA(o.tint);
    const alpha = o.alpha ?? 1;
    return alpha === 1 && this.alpha === 1 ? tint : this.withAlpha(tint, alpha);
  }

  /** Text, rasterised once and cached as a texture (crisp at the current render scale). */
  text(text: string, x: number, y: number, o: TextDrawOptions = {}): void {
    if (!text) return;
    const font = o.font ?? this.defaultFont();
    if (typeof font !== "string") {
      this.bitmapText(text, x, y, font, o);
      return;
    }
    const entry = this.textCache.get(text, font, this.renderScale, (src) => this.backend.invalidate(src));
    const ax = o.align === "center" ? 0.5 : o.align === "right" ? 1 : 0;
    const ay = o.baseline === "middle" ? 0.5 : o.baseline === "bottom" ? 1 : 0;
    this.local(x - ax * entry.w, y - ay * entry.h, entry.w, entry.h);
    const color = this.withAlpha(toRGBA(o.color ?? "#ffffff"), o.alpha ?? 1);
    this.quads++;
    this.backend.quad(this.tmp, entry.canvas, 0, 0, entry.canvas.width, entry.canvas.height, color, 0, true);
  }

  /**
   * The logical box `text()` fills for this string and font, so layouts can align and centre without
   * guessing. Same cache as `text()`, so measuring then drawing rasterises once.
   */
  measure(text: string, font: string | BitmapFont = this.defaultFont()): { w: number; h: number } {
    if (!text) return { w: 0, h: 0 };
    if (typeof font !== "string") return font.measure(text);
    const entry = this.textCache.get(text, font, this.renderScale, (src) => this.backend.invalidate(src));
    return { w: entry.w, h: entry.h };
  }

  private bitmapText(text: string, x: number, y: number, font: BitmapFont, o: TextDrawOptions): void {
    const size = font.measure(text);
    const ay = o.baseline === "middle" ? 0.5 : o.baseline === "bottom" ? 1 : 0;
    const color = this.withAlpha(toRGBA(o.color ?? "#ffffff"), o.alpha ?? 1);
    // Whole-pixel origin: a glyph straddling a pixel boundary would blur or drop a column.
    let ly = Math.round(y - ay * size.h);
    for (const line of text.split("\n")) {
      const w = font.lineWidth(line);
      let lx = Math.round(x - (o.align === "center" ? Math.floor(w / 2) : o.align === "right" ? w : 0));
      for (const ch of line) {
        const g = font.glyph(ch);
        if (!g) continue;
        const f = g.frame;
        this.local(lx, ly, f.w, f.h);
        this.quads++;
        this.backend.quad(this.tmp, f.image, f.x, f.y, f.w, f.h, color, 0, false);
        lx += g.advance + font.spacing;
      }
      ly += font.lineHeight;
    }
  }

  // ---- render targets ----------------------------------------------------------------------

  /** An offscreen image of `width × height` pixels to draw into with `into()`, then draw like any image. */
  createTarget(width: number, height: number): RenderTarget {
    return new RenderTarget(width, height);
  }

  /**
   * Run `fn` with drawing going into `target` instead of the canvas, then switch back. Inside, units are the
   * target's pixels from its top-left; the transform, clips and global alpha start fresh and are restored
   * afterwards. `clear` fills the target first (default transparent); pass `null` to draw over what's there,
   * for trails and accumulation. Nests.
   *
   * ```ts
   * const glow = draw.createTarget(160, 90);
   * draw.into(glow, () => draw.sprites(spark, sparks, n, { tint: "#ffd36b" }));
   * draw.blend("add");
   * draw.sprite(glow, 160, 90, { scaleX: 2, scaleY: 2, smooth: true });
   * ```
   */
  into(target: RenderTarget, fn: () => void, clear: Color | null = 0): void {
    const outer = this.target;
    const outerW = outer ? outer.width : this.viewW;
    const outerH = outer ? outer.height : this.viewH;
    const outerScale = this.renderScale;
    const outerAlpha = this.alpha;
    const outerClips = this.clips.splice(0);
    if (outerClips.length) this.backend.setClip(null);
    const depth = this.depth;
    this.push();
    copy(IDENTITY, this.m);
    this.alpha = 1;
    this.renderScale = 1;
    this.target = target;
    this.backend.setTarget(target, clear === null ? null : toRGBA(clear), target.width, target.height);
    try {
      fn();
    } finally {
      if (this.clips.length) {
        this.clips.length = 0;
        this.backend.setClip(null);
      }
      this.target = outer;
      this.backend.setTarget(outer, null, outerW, outerH);
      this.clips.push(...outerClips);
      const clip = outerClips.at(-1);
      if (clip) this.backend.setClip(clip);
      // Unbalanced push() calls inside fn don't leak out.
      this.depth = depth + 1;
      this.pop();
      this.alpha = outerAlpha;
      this.renderScale = outerScale;
    }
  }

  /** Free a target's GPU memory. Drawing it afterwards recreates it, blank. */
  disposeTarget(target: RenderTarget): void {
    this.backend.disposeTarget(target);
  }

  /** True while the WebGL context is lost (e.g. a backgrounded mobile tab): frames draw nothing until it's restored. */
  get contextLost(): boolean {
    return this.backend.contextLost ?? false;
  }

  /** Re-upload a source whose pixels changed (e.g. a canvas you draw into). */
  invalidate(src: TextureSource): void {
    this.backend.invalidate(src);
  }

  // ---- frame lifecycle (called by Game) ----------------------------------------------------

  /** @internal */
  renderScale = 1;

  /** @internal */
  begin(clear: Color, width: number, height: number, scale: number): void {
    this.renderScale = scale;
    this.viewW = width;
    this.viewH = height;
    this.target = null;
    this.quads = 0;
    this.depth = 0;
    this.clips.length = 0;
    copy(IDENTITY, this.m);
    this.alpha = 1;
    this.backend.setBlend("normal");
    this.backend.begin(toRGBA(clear), width, height, scale);
  }

  /** @internal Reset transform and blend between scene and afterRender hooks. */
  reset(): void {
    this.depth = 0;
    if (this.clips.length) {
      this.clips.length = 0;
      this.backend.setClip(null);
    }
    copy(IDENTITY, this.m);
    this.alpha = 1;
    this.backend.setBlend("normal");
  }

  /** @internal */
  end(): void {
    this.backend.end();
  }

  /** @internal Release GPU resources and listeners. */
  dispose(): void {
    this.backend.dispose();
  }

  /** @internal */
  resize(w: number, h: number): void {
    this.backingW = w;
    this.backingH = h;
    this.backend.resize(w, h);
  }

  /** @internal Switch to a backend that finished loading (the Canvas 2D fallback), at the current size. */
  setBackend(backend: Backend): void {
    this.backend.dispose();
    this.backend = backend;
    if (this.backingW) backend.resize(this.backingW, this.backingH);
  }

  // ---- internals ---------------------------------------------------------------------------

  /** tmp = current matrix × (translate(x, y) · scale(w, h)): maps the unit square to the rect. */
  private local(x: number, y: number, w: number, h: number): void {
    const m = this.m;
    const t = this.tmp;
    t[0] = m[0] * w;
    t[1] = m[1] * w;
    t[2] = m[2] * h;
    t[3] = m[3] * h;
    t[4] = m[0] * x + m[2] * y + m[4];
    t[5] = m[1] * x + m[3] * y + m[5];
  }

  private wholeImage(image: TextureSource): Frame {
    // Loops usually draw one image many times in a row; skip the WeakMap for repeats.
    if (image === this.lastImage && this.lastFrame) return this.lastFrame;
    let f = this.frames.get(image);
    if (!f) {
      f = wholeImage(image);
      this.frames.set(image, f);
    }
    this.lastImage = image;
    this.lastFrame = f;
    return f;
  }

  private defaultFont(): string | BitmapFont {
    return typeof this.font === "function" ? this.font() : this.font;
  }

  private withAlpha(rgba: number, alpha: number): number {
    const a = Math.round((rgba & 0xff) * alpha * this.alpha);
    return ((rgba & 0xffffff00) | Math.max(0, Math.min(255, a))) >>> 0;
  }

  private circle64(): HTMLCanvasElement | OffscreenCanvas {
    if (!this.circleTexture) {
      const c = makeCanvas(64, 64);
      const ctx = c.getContext("2d") as CanvasRenderingContext2D | null;
      if (ctx) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(32, 32, 31.5, 0, Math.PI * 2);
        ctx.fill();
      }
      this.circleTexture = c;
    }
    return this.circleTexture;
  }
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function intersect(a: ClipRect, b: ClipRect): ClipRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, w: Math.max(0, Math.min(a.x + a.w, b.x + b.w) - x), h: Math.max(0, Math.min(a.y + a.h, b.y + b.h) - y) };
}

function copy(from: Matrix, to: Matrix): void {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
  to[3] = from[3];
  to[4] = from[4];
  to[5] = from[5];
}

function wholeImage(image: TextureSource): Frame {
  const w = "naturalWidth" in image ? image.naturalWidth : image.width;
  const h = "naturalHeight" in image ? image.naturalHeight : image.height;
  return { image, x: 0, y: 0, w, h };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

interface TextEntry {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** Logical size. */
  w: number;
  h: number;
  used: number;
}

/** LRU cache of rasterised text (white; tinted at draw time). */
class TextCache {
  private readonly entries = new Map<string, TextEntry>();
  private clock = 0;

  get(text: string, font: string, scale: number, evict: (src: TextureSource) => void): TextEntry {
    const key = `${scale}|${font}|${text}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.used = ++this.clock;
      return hit;
    }
    const measureCtx = makeCanvas(1, 1).getContext("2d") as CanvasRenderingContext2D | null;
    if (!measureCtx) throw new Error("draw.text needs a 2D canvas for rasterising text");
    measureCtx.font = font;
    const metrics = measureCtx.measureText(text);
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
    const w = Math.ceil(metrics.width) + 2;
    const h = Math.ceil(ascent + descent) + 2;
    const canvas = makeCanvas(Math.ceil(w * scale), Math.ceil(h * scale));
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.font = font;
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, 1, 1 + ascent);
    }
    const entry = { canvas, w, h, used: ++this.clock };
    this.entries.set(key, entry);
    if (this.entries.size > 256) {
      // Evict the least recently used quarter.
      const old = [...this.entries].sort((a, b) => a[1].used - b[1].used).slice(0, 64);
      for (const [k, e] of old) {
        this.entries.delete(k);
        evict(e.canvas);
      }
    }
    return entry;
  }
}
