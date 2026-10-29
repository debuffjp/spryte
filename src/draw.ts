import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import type { BitmapFont } from "./bitmap-font.js";
import { type Color, toRGBA } from "./color.js";
import { placeAt, type SpritesEach } from "./copies.js";
import { Shader } from "./shader.js";
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
const NO_EACH: SpritesEach = Object.freeze({});
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
  /** @internal */
  readonly m: Matrix = [1, 0, 0, 1, 0, 0];
  /** @internal Bumped whenever `m` changes, so backends can skip comparing the transform per sprite. */
  mver = 0;
  private readonly frames = new WeakMap<TextureSource, Frame>();
  private lastImage: TextureSource | null = null;
  private lastFrame: Frame | undefined;
  /** @internal */
  readonly clips: ClipRect[] = [];
  /** @internal */
  shader: Shader | null = null;
  /** The render target being drawn into, or null for the canvas. */
  /** @internal */
  target: RenderTarget | null = null;
  /** The canvas's logical size this frame. */
  /** @internal */
  viewW = 1;
  /** @internal */
  viewH = 1;
  /** The logical size of the current destination: the canvas, a target inside `into()`, or a mask or filter pass. */
  /** @internal */
  destW = 1;
  /** @internal */
  destH = 1;
  /** @internal */
  readonly tmp: Matrix = [1, 0, 0, 1, 0, 0];
  private readonly textCache = new TextCache();
  /** Antialiased white circles, 64, 256 and 1024px across, each made on first use. */
  private readonly circleTextures: (HTMLCanvasElement | OffscreenCanvas | undefined)[] = [];

  /** @internal */

  backingW = 0;
  /** @internal */
  backingH = 0;

  /** @internal */
  constructor(
    /** @internal */
    public backend: Backend,
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
    this.mver++;
  }

  translate(x: number, y: number): void {
    const m = this.m;
    m[4] += m[0] * x + m[2] * y;
    m[5] += m[1] * x + m[3] * y;
    this.mver++;
  }

  /**
   * Multiply a matrix `[a, b, c, d, e, f]` (x' = a·x + c·y + e, y' = b·x + d·y + f, the Canvas order) onto the
   * current transform, the way `translate`, `scale` and `rotate` do. For a camera or parent transform another
   * engine computed, which can include skew that those three can't express.
   */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    const m = this.m;
    const [m0, m1, m2, m3] = m;
    m[4] += m0 * e + m2 * f;
    m[5] += m1 * e + m3 * f;
    m[0] = m0 * a + m2 * b;
    m[1] = m1 * a + m3 * b;
    m[2] = m0 * c + m2 * d;
    m[3] = m1 * c + m3 * d;
    this.mver++;
  }

  scale(x: number, y = x): void {
    const m = this.m;
    m[0] *= x;
    m[1] *= x;
    m[2] *= y;
    m[3] *= y;
    this.mver++;
  }

  rotate(radians: number): void {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const [a, b, cc, d] = this.m;
    this.m[0] = a * c + cc * s;
    this.m[1] = b * c + d * s;
    this.m[2] = cc * c - a * s;
    this.m[3] = d * c - b * s;
    this.mver++;
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
    this.mver++;
    try {
      fn();
    } finally {
      this.pop();
    }
  }

  // ---- drawing ---------------------------------------------------------------------------

  blend(mode: BlendMode): void {
    this.blendMode = mode;
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
    // Pick the texture closest to the circle's size on screen: magnified, a small one blurs; shrunk a lot, a big
    // one (no mipmaps) gets jaggy.
    const m = this.m;
    const device = radius * Math.hypot(m[0], m[1]) * (this.backingW ? this.backingW / this.viewW : 1);
    const size = device <= 40 ? 64 : device <= 160 ? 256 : 1024;
    this.quads++;
    this.backend.quad(this.tmp, this.circleTexture(size), 0, 0, size, size, this.withAlpha(toRGBA(color), 1), 0, true);
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
    const b = this.backend;
    if (b.sprite) {
      // The backend does the transform algebra itself (on the GPU).
      this.quads++;
      b.sprite(this.mver, this.m, this.frameOf(frame), x, y, o, this.spriteColor(o), o.smooth ?? this.smooth);
      return;
    }
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
   * Much faster than calling `sprite()` in a loop, with no per-sprite allocation.
   *
   * ```ts
   * const pos = new Float32Array(2 * MAX);
   * // ...update pos...
   * draw.sprites(spark, pos, live, { tint: "#ffd36b", alpha: 0.8 });
   * ```
   *
   * Per-copy scale, rotation, colour and frame go in `each`. For a frame per copy, pass the frames as an
   * array and index it with `each.frame`:
   *
   * ```ts
   * draw.sprites(itemFrames, pos, n, {}, { frame: itemKind });
   * ```
   */
  sprites(
    frame: Frame | TextureSource | readonly Frame[],
    positions: ArrayLike<number>,
    count = positions.length >> 1,
    o: SpriteDrawOptions = NO_OPTIONS,
    each?: SpritesEach,
  ): void {
    // Never read past the arrays: GL would reject the whole upload and draw nothing.
    const stride = each?.stride;
    if (stride) {
      // Interleaved records are uploaded as is (and colour bits read through a view), so they must be floats.
      if (!(positions instanceof Float32Array)) throw new TypeError("draw.sprites: with each.stride, positions must be a Float32Array");
      // Every offset used must fit inside the last record.
      const e = each as SpritesEach;
      let last = (e.position ?? 0) + 1;
      for (const field of [e.scale, e.rotation, e.color, e.frame]) if (typeof field === "number") last = Math.max(last, field);
      count = Math.min(Math.floor(count) || 0, Math.floor((positions.length - last - 1) / stride) + 1);
    } else count = Math.min(Math.floor(count) || 0, positions.length >> 1);
    if (each && !stride) {
      for (const field of [each.scale, each.rotation, each.color, each.frame]) {
        if (typeof field === "number") throw new TypeError("draw.sprites: offsets in each need each.stride");
        if (field !== undefined) count = Math.min(count, field.length);
      }
    }
    if (count <= 0) return;
    // Under a custom shader, the per-copy program runs the effect: route plain copies through it too.
    if (stride || this.shader || (each && (each.scale || each.rotation || each.color || each.frame))) {
      this.spritesEach(frame, positions, count, o, each ?? NO_EACH);
      return;
    }
    const f = this.place(Array.isArray(frame) ? (frame[0] as Frame) : (frame as Frame | TextureSource), 0, 0, o);
    const t = this.tmp;
    const smooth = o.smooth ?? this.smooth;
    // Snapped per copy, like sprite().
    const snap = !smooth && t[1] === 0 && t[2] === 0;
    this.quads += count;
    this.backend.quads(t, this.m, positions, count, f.image, f.x, f.y, f.w, f.h, this.spriteColor(o), o.flash ?? 0, smooth, snap);
  }

  private spritesEach(
    frame: Frame | TextureSource | readonly Frame[],
    positions: ArrayLike<number>,
    count: number,
    o: SpriteDrawOptions,
    each: SpritesEach,
  ): void {
    let frames: readonly Frame[] | undefined;
    let f: Frame;
    let mixed = false;
    if (Array.isArray(frame)) {
      const all = frame as readonly Frame[];
      f = all[0] as Frame;
      if (!f) return;
      if (each.frame !== undefined) {
        frames = all;
        for (let i = 1; i < all.length && !mixed; i++) mixed = (all[i] as Frame).image !== f.image;
      }
    } else {
      const one = frame as Frame | TextureSource;
      f = one === this.lastImage && this.lastFrame ? this.lastFrame : "image" in one ? one : this.wholeImage(one);
    }
    const origin = o.origin;
    const rotation = o.rotation ?? 0;
    const smooth = o.smooth ?? this.smooth;
    const m = this.m;
    this.quads += count;
    this.backend.copies({
      m,
      positions,
      count,
      frame: f,
      originX: origin ? origin[0] : 0.5,
      originY: origin ? origin[1] : 0.5,
      frames,
      mixed,
      scaleX: (o.scaleX ?? 1) * (o.flipX ? -1 : 1),
      scaleY: (o.scaleY ?? 1) * (o.flipY ? -1 : 1),
      rotation,
      color: this.spriteColor(o),
      flash: o.flash ?? 0,
      smooth,
      // Like sprite(): per copy, whole pixels when that copy doesn't rotate.
      snap: !smooth && m[1] === 0 && m[2] === 0,
      each,
      stride: each.stride || 2,
      offset: each.stride ? (each.position ?? 0) : 0,
      bits:
        typeof each.color === "number"
          ? new Uint32Array((positions as Float32Array).buffer, (positions as Float32Array).byteOffset)
          : undefined,
    });
  }

  /** tmp = M · T(x, y) · R(rotation) · S(sx, sy) · T(ox, oy) · S(w, h), expanded by hand. Returns the frame. */
  private place(frame: Frame | TextureSource, x: number, y: number, o: SpriteDrawOptions): Frame {
    const f = this.frameOf(frame);
    const origin = o.origin;
    placeAt(
      this.m,
      f.w,
      f.h,
      x,
      y,
      origin ? origin[0] : 0.5,
      origin ? origin[1] : 0.5,
      (o.scaleX ?? 1) * (o.flipX ? -1 : 1),
      (o.scaleY ?? 1) * (o.flipY ? -1 : 1),
      o.rotation ?? 0,
      this.tmp,
    );
    return f;
  }

  private frameOf(frame: Frame | TextureSource): Frame {
    // Check the repeat-image cache before `in`: on a DOM image, `in` walks a long prototype chain per call.
    return frame === this.lastImage && this.lastFrame ? this.lastFrame : "image" in frame ? frame : this.wholeImage(frame);
  }

  /** @internal */

  spriteColor(o: SpriteDrawOptions): number {
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
    const entry = this.textCache.get(text, font, this.renderScale, this.backend);
    const ax = o.align === "center" ? 0.5 : o.align === "right" ? 1 : 0;
    const ay = o.baseline === "middle" ? 0.5 : o.baseline === "bottom" ? 1 : 0;
    this.local(x - ax * entry.w, y - ay * entry.h, entry.w, entry.h);
    const color = this.withAlpha(toRGBA(o.color ?? "#ffffff"), o.alpha ?? 1);
    this.quads++;
    this.backend.quad(this.tmp, entry.src, entry.sx, entry.sy, entry.sw, entry.sh, color, 0, true);
  }

  /**
   * The logical box `text()` fills for this string and font, so layouts can align and centre without
   * guessing. Same cache as `text()`, so measuring then drawing rasterises once.
   */
  measure(text: string, font: string | BitmapFont = this.defaultFont()): { w: number; h: number } {
    if (!text) return { w: 0, h: 0 };
    if (typeof font !== "string") return font.measure(text);
    const entry = this.textCache.get(text, font, this.renderScale, this.backend);
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
    const outerW = this.destW;
    const outerH = this.destH;
    const outerScale = this.renderScale;
    const outerAlpha = this.alpha;
    const outerClips = this.clips.splice(0);
    const depth = this.depth;
    this.push();
    // Everything from here is undone by the finally, so a target the backend refuses leaves no trace.
    try {
      if (outerClips.length) this.backend.setClip(null);
      copy(IDENTITY, this.m);
      this.mver++;
      this.alpha = 1;
      this.renderScale = 1;
      this.target = target;
      this.destW = target.width;
      this.destH = target.height;
      this.backend.setTarget(target, clear === null ? null : toRGBA(clear), target.width, target.height);
      fn();
    } finally {
      if (this.clips.length) {
        this.clips.length = 0;
        this.backend.setClip(null);
      }
      this.target = outer;
      this.destW = outerW;
      this.destH = outerH;
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

  // ---- shaders ------------------------------------------------------------------------------

  /** A custom fragment effect: see `Shader`. Compiled on first use, so errors surface at the first `withShader` draw. */
  createShader(source: string): Shader {
    return new Shader(source);
  }

  /** Run `fn` with everything drawn through `shader`, then restore the previous one. Nests. WebGL2 only (see `Shader`). */
  withShader(shader: Shader, fn: () => void): void {
    const outer = this.shader;
    // Switch the backend first: if the shader fails to compile, nothing has changed.
    this.backend.setShader(shader);
    this.shader = shader;
    try {
      fn();
    } finally {
      this.shader = outer;
      this.backend.setShader(outer);
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
    this.frames.delete(src);
    if (this.lastImage === src) this.lastImage = null;
  }

  // ---- frame lifecycle (called by Game) ----------------------------------------------------

  /** @internal */
  renderScale = 1;

  /**
   * Start a frame: clear to `clear` (null draws over what's there: an overlay, a second pass, or a frame another
   * engine began), at a logical size of `width × height` units with `scale` backing pixels per unit (2 on a 2×
   * screen, or the canvas's pixel width / `width`). Resets the transform, alpha, blend and clips.
   */
  begin(clear: Color | null, width: number, height: number, scale: number): void {
    this.textCache.frame++;
    this.renderScale = scale;
    this.viewW = width;
    this.viewH = height;
    this.destW = width;
    this.destH = height;
    this.target = null;
    this.shader = null;
    this.quads = 0;
    this.depth = 0;
    this.clips.length = 0;
    copy(IDENTITY, this.m);
    this.mver++;
    this.alpha = 1;
    this.maskDepth = 0;
    this.blend("normal");
    this.backend.begin(clear === null ? null : toRGBA(clear), width, height, scale);
  }

  /** @internal Reset transform and blend between scene and afterRender hooks. */
  reset(): void {
    this.depth = 0;
    if (this.clips.length) {
      this.clips.length = 0;
      this.backend.setClip(null);
    }
    copy(IDENTITY, this.m);
    this.mver++;
    this.alpha = 1;
    this.blend("normal");
  }

  /** Finish the frame: submits everything drawn since `begin()`. */
  end(): void {
    this.backend.end();
  }

  /** Release GPU resources and listeners. Using this `Draw` afterwards throws; disposing again does nothing. */
  dispose(): void {
    this.backend.dispose();
    this.backend = disposed(this.backend);
  }

  /** Tell spryte the canvas's backing size changed: call it with `canvas.width, canvas.height` after setting them. */
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

  /** @internal */

  blendMode: BlendMode = "normal";
  /** @internal */
  maskDepth = 0;

  /** tmp = current matrix × (translate(x, y) · scale(w, h)): maps the unit square to the rect. */
  /** @internal */
  local(x: number, y: number, w: number, h: number): void {
    const m = this.m;
    const t = this.tmp;
    t[0] = m[0] * w;
    t[1] = m[1] * w;
    t[2] = m[2] * h;
    t[3] = m[3] * h;
    t[4] = m[0] * x + m[2] * y + m[4];
    t[5] = m[1] * x + m[3] * y + m[5];
  }

  /** @internal */

  wholeImage(image: TextureSource): Frame {
    // Loops usually draw one image many times in a row; skip the WeakMap for repeats.
    if (image === this.lastImage && this.lastFrame) return this.lastFrame;
    let f = this.frames.get(image);
    if (!f) {
      f = wholeImage(image);
      // An image still loading is 0×0: remember nothing, so its real size is read once it has loaded.
      if (f.w === 0 || f.h === 0) return f;
      this.frames.set(image, f);
    }
    this.lastImage = image;
    this.lastFrame = f;
    return f;
  }

  private defaultFont(): string | BitmapFont {
    return typeof this.font === "function" ? this.font() : this.font;
  }

  /** @internal */

  withAlpha(rgba: number, alpha: number): number {
    const a = Math.round((rgba & 0xff) * alpha * this.alpha);
    return ((rgba & 0xffffff00) | Math.max(0, Math.min(255, a))) >>> 0;
  }

  private circleTexture(size: 64 | 256 | 1024): HTMLCanvasElement | OffscreenCanvas {
    const slot = size === 64 ? 0 : size === 256 ? 1 : 2;
    let c = this.circleTextures[slot];
    if (!c) {
      c = makeCanvas(size, size);
      const ctx = c.getContext("2d") as CanvasRenderingContext2D | null;
      if (ctx) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      this.circleTextures[slot] = c;
    }
    return c;
  }
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Stands in for a disposed backend: any drawing throws a clear error instead of touching dead GPU objects. */
function disposed(was: Backend): Backend {
  const fail = () => {
    throw new Error("spryte: this renderer was disposed; create a new one with createRenderer()");
  };
  return {
    kind: was.kind,
    raw: was.raw,
    begin: fail,
    quad: fail,
    path: fail,
    quads: fail,
    copies: fail,
    setBlend: fail,
    setClip: fail,
    setTarget: fail,
    setShader: fail,
    disposeTarget: () => {},
    end: fail,
    resize: () => {},
    invalidate: () => {},
    dispose: () => {},
  };
}

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
  /** The image holding the rasterised string: an atlas page, or its own canvas. */
  src: HTMLCanvasElement | OffscreenCanvas;
  /** Source rect in `src`, in pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Logical size. */
  w: number;
  h: number;
  /** The atlas page it lives on, or null for its own canvas. */
  page: AtlasPage | null;
  /** The frame it was last drawn in. */
  frame: number;
  used: number;
}

/** Atlas pages are this many pixels square. */
const PAGE = 1024;

interface AtlasPage {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  /** Shelf packing: the current shelf's top and height, and the next free x on it. */
  shelfY: number;
  shelfH: number;
  x: number;
  /** The last frame a string on this page was drawn in. */
  frame: number;
  keys: string[];
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Cache of rasterised text (white; tinted at draw time).
 *
 * On WebGL2, strings are packed into shared atlas pages, and a new string uploads only its own rectangle. Text
 * that changes every frame (scores, timers, damage numbers) then costs one small upload per new string instead
 * of a new texture each, and the labels on a page batch into one draw call. A full page is recycled once none
 * of its strings was drawn this frame or the last; while every page is in use, a new page is added.
 *
 * On the Canvas 2D fallback, and for a string too big for a page, each string gets its own canvas, kept in an
 * LRU of at least 256 strings that never evicts one drawn this frame or the last.
 */
class TextCache {
  private readonly entries = new Map<string, TextEntry>();
  private readonly pages: AtlasPage[] = [];
  private clock = 0;
  /** Advanced by `begin()`. */
  frame = 0;
  private limit = 256;
  private measureCtx: Ctx2D | null = null;
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null;

  get(text: string, font: string, scale: number, backend: Backend): TextEntry {
    const key = `${scale}|${font}|${text}`;
    const hit = this.entries.get(key);
    if (hit) {
      hit.used = ++this.clock;
      hit.frame = this.frame;
      if (hit.page) hit.page.frame = this.frame;
      return hit;
    }
    if (!this.measureCtx) {
      this.measureCtx = makeCanvas(1, 1).getContext("2d") as Ctx2D | null;
      if (!this.measureCtx) throw new Error("draw.text needs a 2D canvas for rasterising text");
    }
    this.measureCtx.font = font;
    const metrics = this.measureCtx.measureText(text);
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
    const w = Math.ceil(metrics.width) + 2;
    const h = Math.ceil(ascent + descent) + 2;
    const pw = Math.ceil(w * scale);
    const ph = Math.ceil(h * scale);
    const draw = (ctx: Ctx2D) => {
      ctx.scale(scale, scale);
      ctx.font = font;
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(text, 1, 1 + ascent);
    };
    const entry =
      backend.update && pw + 2 <= PAGE && ph + 2 <= PAGE / 8
        ? this.pack(key, pw, ph, w, h, draw, backend)
        : this.own(pw, ph, w, h, draw, backend);
    this.entries.set(key, entry);
    return entry;
  }

  /** Rasterise into an atlas page and upload just that rectangle. */
  private pack(key: string, pw: number, ph: number, w: number, h: number, draw: (ctx: Ctx2D) => void, backend: Backend): TextEntry {
    const page = this.room(pw, ph);
    // A pixel of gap around each string, so linear filtering never picks up a neighbour.
    const sx = page.x + 1;
    const sy = page.shelfY + 1;
    page.x += pw + 2;
    page.keys.push(key);
    page.frame = this.frame;
    if (!this.scratch || this.scratch.width < pw || this.scratch.height < ph)
      this.scratch = makeCanvas(Math.max(pw, 256), Math.max(ph, 64));
    const sc = this.scratch.getContext("2d") as Ctx2D | null;
    if (sc) {
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, this.scratch.width, this.scratch.height);
      draw(sc);
      // The page keeps a copy, so the whole texture can be rebuilt (a lost context, or its first use).
      page.ctx.clearRect(sx, sy, pw, ph);
      page.ctx.drawImage(this.scratch, 0, 0, pw, ph, sx, sy, pw, ph);
      backend.update?.(page.canvas, sx, sy, this.scratch, pw, ph);
    }
    return { src: page.canvas, sx, sy, sw: pw, sh: ph, w, h, page, frame: this.frame, used: ++this.clock };
  }

  /** A page with room for a `pw × ph` string: the current one, a recycled one, or a new one. */
  private room(pw: number, ph: number): AtlasPage {
    const current = this.pages[this.pages.length - 1];
    if (current) {
      if (current.x + pw + 2 <= PAGE && ph + 2 <= current.shelfH) return current;
      // Start a new shelf below the current one.
      const y = current.shelfY + current.shelfH;
      if (y + ph + 2 <= PAGE) {
        current.shelfY = y;
        current.shelfH = ph + 2;
        current.x = 0;
        return current;
      }
    }
    // Recycle the least recently drawn page that nothing on screen uses (not drawn this frame or the last).
    let free: AtlasPage | undefined;
    for (const p of this.pages) if (p.frame < this.frame - 1 && (!free || p.frame < free.frame)) free = p;
    if (free) {
      for (const k of free.keys) this.entries.delete(k);
      free.keys.length = 0;
      this.pages.splice(this.pages.indexOf(free), 1);
    } else {
      const canvas = makeCanvas(PAGE, PAGE);
      const ctx = canvas.getContext("2d") as Ctx2D | null;
      if (!ctx) throw new Error("draw.text needs a 2D canvas for rasterising text");
      free = { canvas, ctx, shelfY: 0, shelfH: 0, x: 0, frame: this.frame, keys: [] };
    }
    free.shelfY = 0;
    free.shelfH = ph + 2;
    free.x = 0;
    // Last in the list is the current page.
    this.pages.push(free);
    return free;
  }

  /** Its own canvas: the Canvas 2D fallback, or a string too big for a page. */
  private own(pw: number, ph: number, w: number, h: number, draw: (ctx: Ctx2D) => void, backend: Backend): TextEntry {
    const canvas = makeCanvas(pw, ph);
    const ctx = canvas.getContext("2d") as Ctx2D | null;
    if (ctx) draw(ctx);
    let owned = 1;
    for (const e of this.entries.values()) if (!e.page) owned++;
    if (owned > this.limit) {
      // Evict the least recently used quarter, never anything drawn this frame or the last.
      const stale = [...this.entries].filter(([, e]) => !e.page && e.frame < this.frame - 1).sort((a, b) => a[1].used - b[1].used);
      const evict = stale.slice(0, Math.max(64, owned >> 2));
      for (const [k, e] of evict) {
        this.entries.delete(k);
        backend.invalidate(e.src);
      }
      // Still full of live strings: the screen needs more, so make room for them.
      if (owned - evict.length > this.limit) this.limit = Math.max(256, owned * 2);
    }
    return { src: canvas, sx: 0, sy: 0, sw: pw, sh: ph, w, h, page: null, frame: this.frame, used: ++this.clock };
  }
}
