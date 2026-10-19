import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import { RenderTarget } from "./target.js";

/** Texture units sampled per batch. 8 is guaranteed on every WebGL2 implementation's fragment stage (min 16). */
const UNITS = 8;

const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec3 a_m0;       // a, c, e
layout(location=2) in vec3 a_m1;       // b, d, f
layout(location=3) in vec4 a_uv;       // u0, v0, u1, v1 (normalised)
layout(location=4) in vec2 a_extra;    // flash, texture unit
layout(location=5) in vec4 a_color;    // normalised RGBA
uniform vec2 u_view;
out highp vec2 v_uv;
out vec4 v_color;
out float v_flash;
flat out int v_unit;
void main() {
  vec2 p = vec2(dot(a_m0, vec3(a_corner, 1.0)), dot(a_m1, vec3(a_corner, 1.0)));
  vec2 clip = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
  v_flash = a_extra.x;
  v_unit = int(a_extra.y);
}`;

/** Copies of one quad that differ only in position (`draw.sprites`): 8 bytes per copy instead of 52. */
const COPY_VERT = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
uniform vec2 u_view;
uniform vec4 u_quad;    // a, b, c, d: the unit square onto the sprite
uniform vec2 u_origin;  // e, f for a copy at (0, 0)
uniform vec4 u_linear;  // the current transform's linear part, moving each copy
uniform vec4 u_uv;
uniform float u_snap;
out highp vec2 v_uv;
void main() {
  vec2 e = u_origin + mat2(u_linear.xy, u_linear.zw) * a_pos;
  // Same rule as draw.sprite() for unrotated pixel art: whole pixels (Math.round == floor(x + 0.5)).
  if (u_snap > 0.5) e = floor(e + 0.5);
  vec2 p = mat2(u_quad.xy, u_quad.zw) * a_corner + e;
  vec2 clip = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(u_uv.xy, u_uv.zw, a_corner);
}`;

const COPY_FRAG = `#version 300 es
precision mediump float;
in highp vec2 v_uv;
uniform sampler2D u_tex;
uniform vec4 u_color;
uniform float u_flash;
out vec4 outColor;
void main() {
  vec4 t = texture(u_tex, v_uv) * vec4(u_color.rgb * u_color.a, u_color.a);
  outColor = vec4(mix(t.rgb, vec3(t.a), u_flash), t.a);
}`;

interface CopyPipeline {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  view: WebGLUniformLocation | null;
  quad: WebGLUniformLocation | null;
  origin: WebGLUniformLocation | null;
  linear: WebGLUniformLocation | null;
  uv: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  flash: WebGLUniformLocation | null;
  snap: WebGLUniformLocation | null;
}

const FRAG = `#version 300 es
precision mediump float;
// highp: mediump is fp16 on many mobile GPUs, too coarse to address texels in atlases past ~1024 px.
in highp vec2 v_uv;
in vec4 v_color;
in float v_flash;
flat in int v_unit;
uniform sampler2D u_tex[${UNITS}];
out vec4 outColor;
vec4 sampleUnit(int unit, vec2 uv) {
  ${Array.from({ length: UNITS }, (_, i) => `if (unit == ${i}) return texture(u_tex[${i}], uv);`).join("\n  ")}
  return vec4(1.0);
}
void main() {
  vec4 t = sampleUnit(v_unit, v_uv) * v_color;
  // Flash: push colour toward white while keeping alpha (premultiplied).
  outColor = vec4(mix(t.rgb, vec3(t.a), v_flash), t.a);
}`;

/** Floats per instance before the 4-byte colour. */
const FLOATS = 12;
const STRIDE = FLOATS * 4 + 4;

interface CachedTexture {
  tex: WebGLTexture;
  /** 1 / width and ±1 / height, so UV maths multiplies instead of divides. */
  iw: number;
  ih: number;
  /** v at the image's top row: 0, or 1 for render targets, which WebGL stores bottom row first (`ih` is then negative). */
  v0: number;
}

/** Instanced, multi-texture WebGL2 sprite batcher behind the `draw` API. */
export class WebGL2Backend implements Backend {
  readonly kind = "webgl2" as const;
  readonly raw: RawContext;
  private readonly gl: WebGL2RenderingContext;
  private readonly capacity = 16_384;
  private readonly data = new ArrayBuffer(this.capacity * STRIDE);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  // GPU objects are recreated after a context loss, so they are not readonly.
  private instanceBuffer!: WebGLBuffer;
  private viewLoc: WebGLUniformLocation | null = null;
  private readonly textures = new Map<TextureSource, CachedTexture>();
  private white!: CachedTexture;
  /** Filtering lives in sampler objects, so one upload serves smooth and pixelated draws. */
  private nearest!: WebGLSampler;
  private linear!: WebGLSampler;
  private program!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private quadBuffer!: WebGLBuffer;
  private copies!: CopyPipeline;
  private staging = new Float32Array(0);
  private readonly targets = new Map<RenderTarget, { fbo: WebGLFramebuffer; cached: CachedTexture }>();
  /** Where drawing goes: a render target, or null for the canvas. */
  private target: RenderTarget | null = null;
  /** Height in pixels of the current destination, for flipping scissor rectangles. */
  private outH = 1;
  private viewW = 1;
  private viewH = 1;
  /** True between webglcontextlost and webglcontextrestored: drawing is skipped. */
  private lost = false;
  private readonly onLost = (e: Event) => {
    // preventDefault tells the browser we will handle restoration.
    e.preventDefault();
    this.lost = true;
  };
  private readonly onRestored = () => {
    // Every GPU object died with the context. Sources are still in memory, so textures re-upload lazily.
    // Render targets come back blank.
    this.textures.clear();
    this.targets.clear();
    this.target = null;
    this.lastSrc = null;
    this.last = undefined;
    this.count = 0;
    this.unitCount = 0;
    this.setup();
    this.lost = false;
  };
  private readonly units: (WebGLTexture | null)[] = new Array(UNITS).fill(null);
  private readonly unitSmooth: boolean[] = new Array(UNITS).fill(false);
  private unitCount = 0;
  private lastUnit = 0;
  private lastSmooth = false;
  private lastSrc: TextureSource | null = null;
  private last: CachedTexture | undefined;
  private count = 0;
  private blend: BlendMode = "normal";
  private submitted = 0;

  /** Draw calls this frame, counting the batch still pending (read before `end()` flushes it). */
  get drawCalls(): number {
    return this.submitted + (this.count > 0 ? 1 : 0);
  }

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.raw = { kind: "webgl2", gl };
    this.setup();
    gl.canvas.addEventListener("webglcontextlost", this.onLost);
    gl.canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  /** True while the GPU context is lost (e.g. a mobile tab was backgrounded or the driver reset). */
  get contextLost(): boolean {
    return this.lost;
  }

  /** Create program, buffers and the white texture. Runs at start and after a context restore. */
  private setup(): void {
    const gl = this.gl;
    this.outH = gl.drawingBufferHeight;
    const program = link(gl, VERT, FRAG);
    this.program = program;
    gl.useProgram(program);
    this.viewLoc = gl.getUniformLocation(program, "u_view");
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_tex"),
      Array.from({ length: UNITS }, (_, i) => i),
    );

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    this.quadBuffer = quad;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const instances = gl.createBuffer();
    if (!instances) throw new Error("WebGL2: could not create instance buffer");
    this.instanceBuffer = instances;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const attr = (loc: number, size: number, type: number, normalise: boolean, offset: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalise, STRIDE, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(1, 3, gl.FLOAT, false, 0);
    attr(2, 3, gl.FLOAT, false, 12);
    attr(3, 4, gl.FLOAT, false, 24);
    attr(4, 2, gl.FLOAT, false, 40);
    attr(5, 4, gl.UNSIGNED_BYTE, true, 48);

    gl.enable(gl.BLEND);
    this.applyBlend();
    const pixel = new Uint8Array([255, 255, 255, 255]);
    const whiteTex = gl.createTexture();
    if (!whiteTex) throw new Error("WebGL2: could not create texture");
    gl.bindTexture(gl.TEXTURE_2D, whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    this.white = { tex: whiteTex, iw: 1, ih: 1, v0: 0 };
    this.wrap();
    this.nearest = sampler(gl, gl.NEAREST);
    this.linear = sampler(gl, gl.LINEAR);
    this.copies = this.copyPipeline(quad);
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
  }

  begin(clear: number, width: number, height: number): void {
    if (this.lost) return;
    const gl = this.gl;
    if (this.target) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.target = null;
    this.outH = gl.drawingBufferHeight;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(this.viewLoc, width, height);
    this.viewW = width;
    this.viewH = height;
    gl.clearColor((clear >>> 24) / 255, ((clear >>> 16) & 0xff) / 255, ((clear >>> 8) & 0xff) / 255, (clear & 0xff) / 255);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.submitted = 0;
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
    if (this.lost) return;
    // Fast path: consecutive draws from the same source skip the texture lookup.
    if (src !== null && src === this.target) throw new Error("spryte: can't draw a render target into itself");
    const t = src === null ? this.white : src === this.lastSrc && this.last ? this.last : this.texture(src);
    const sameAsLast = t === this.last;
    this.lastSrc = src;
    this.last = t;
    if (this.count === this.capacity) this.flush();
    // Same texture and filter as the previous quad in this batch: same unit.
    let unit =
      sameAsLast && smooth === this.lastSmooth && this.lastUnit < this.unitCount && this.units[this.lastUnit] === t.tex
        ? this.lastUnit
        : -1;
    if (unit < 0)
      for (let i = 0; i < this.unitCount; i++) {
        if (this.units[i] === t.tex && this.unitSmooth[i] === smooth) {
          unit = i;
          break;
        }
      }
    if (unit < 0) {
      if (this.unitCount === UNITS) this.flush();
      unit = this.unitCount++;
      this.units[unit] = t.tex;
      this.unitSmooth[unit] = smooth;
    }
    this.lastUnit = unit;
    this.lastSmooth = smooth;
    const f = this.count * (STRIDE / 4);
    const { f32 } = this;
    f32[f] = m[0];
    f32[f + 1] = m[2];
    f32[f + 2] = m[4];
    f32[f + 3] = m[1];
    f32[f + 4] = m[3];
    f32[f + 5] = m[5];
    f32[f + 6] = sx * t.iw;
    f32[f + 7] = t.v0 + sy * t.ih;
    f32[f + 8] = (sx + sw) * t.iw;
    f32[f + 9] = t.v0 + (sy + sh) * t.ih;
    f32[f + 10] = flash;
    f32[f + 11] = unit;
    // Bytes in memory must read R, G, B, A; Uint32 is little-endian.
    this.u32[f + 12] =
      color === 0xffffffff
        ? color
        : ((color & 0xff) << 24) | (((color >>> 8) & 0xff) << 16) | (((color >>> 16) & 0xff) << 8) | (color >>> 24);
    this.count++;
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
    if (this.lost || count <= 0) return;
    if (src === this.target) throw new Error("spryte: can't draw a render target into itself");
    // Draw order: everything queued so far goes first.
    this.flush();
    const gl = this.gl;
    const tex = src === this.lastSrc && this.last ? this.last : this.texture(src);
    this.lastSrc = src;
    this.last = tex;
    const c = this.copies;
    gl.useProgram(c.program);
    gl.bindVertexArray(c.vao);
    gl.uniform2f(c.view, this.viewW, this.viewH);
    gl.uniform4f(c.quad, t[0], t[1], t[2], t[3]);
    gl.uniform2f(c.origin, t[4], t[5]);
    gl.uniform4f(c.linear, m[0], m[1], m[2], m[3]);
    gl.uniform4f(c.uv, sx * tex.iw, tex.v0 + sy * tex.ih, (sx + sw) * tex.iw, tex.v0 + (sy + sh) * tex.ih);
    gl.uniform4f(c.color, (color >>> 24) / 255, ((color >>> 16) & 0xff) / 255, ((color >>> 8) & 0xff) / 255, (color & 0xff) / 255);
    gl.uniform1f(c.flash, flash);
    gl.uniform1f(c.snap, snap ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.bindSampler(0, smooth ? this.linear : this.nearest);
    gl.bindBuffer(gl.ARRAY_BUFFER, c.buffer);
    // A Float32Array goes to the GPU as is: no per-copy work on the CPU at all.
    let data: Float32Array;
    if (positions instanceof Float32Array) data = positions;
    else {
      if (this.staging.length < count * 2) this.staging = new Float32Array(count * 2);
      data = this.staging;
      for (let i = 0; i < count * 2; i++) data[i] = positions[i] as number;
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW, 0, count * 2);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    this.submitted++;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
  }

  setBlend(mode: BlendMode): void {
    if (mode === this.blend || this.lost) return;
    this.flush();
    this.blend = mode;
    this.applyBlend();
  }

  setClip(rect: ClipRect | null): void {
    if (this.lost) return;
    this.flush();
    const gl = this.gl;
    if (!rect) {
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    gl.enable(gl.SCISSOR_TEST);
    // WebGL's scissor origin is bottom-left.
    gl.scissor(rect.x, this.outH - rect.y - rect.h, rect.w, rect.h);
  }

  end(): void {
    this.flush();
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  resize(): void {
    // The viewport is set from drawingBufferWidth/Height at the start of each frame.
  }

  invalidate(src: TextureSource): void {
    // A target's texture is its contents: there is nothing to re-upload.
    if (src instanceof RenderTarget) return;
    const cached = this.textures.get(src);
    if (!cached) return;
    this.flush();
    this.gl.deleteTexture(cached.tex);
    this.textures.delete(src);
    if (this.lastSrc === src) this.lastSrc = null;
  }

  /** Release every GPU object this backend created, so renderers can be created and destroyed repeatedly. */
  dispose(): void {
    const gl = this.gl;
    gl.canvas.removeEventListener("webglcontextlost", this.onLost);
    gl.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (!this.lost) {
      for (const { tex } of this.textures.values()) gl.deleteTexture(tex);
      gl.deleteTexture(this.white.tex);
      gl.deleteSampler(this.nearest);
      gl.deleteSampler(this.linear);
      gl.deleteBuffer(this.instanceBuffer);
      gl.deleteBuffer(this.quadBuffer);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.program);
      for (const { fbo } of this.targets.values()) gl.deleteFramebuffer(fbo);
      gl.deleteProgram(this.copies.program);
      gl.deleteVertexArray(this.copies.vao);
      gl.deleteBuffer(this.copies.buffer);
    }
    this.textures.clear();
    this.targets.clear();
    this.lastSrc = null;
    this.last = undefined;
  }

  setTarget(target: RenderTarget | null, clear: number | null, width: number, height: number): void {
    if (this.lost) {
      this.target = target;
      return;
    }
    this.flush();
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targetStore(target).fbo);
      gl.viewport(0, 0, target.width, target.height);
      this.outH = target.height;
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      this.outH = gl.drawingBufferHeight;
    }
    this.target = target;
    gl.uniform2f(this.viewLoc, width, height);
    this.viewW = width;
    this.viewH = height;
    if (clear !== null) {
      gl.clearColor((clear >>> 24) / 255, ((clear >>> 16) & 0xff) / 255, ((clear >>> 8) & 0xff) / 255, (clear & 0xff) / 255);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  disposeTarget(target: RenderTarget): void {
    if (target === this.target) throw new Error("spryte: can't dispose a render target while drawing into it");
    const store = this.targets.get(target);
    if (!store) return;
    this.flush();
    if (!this.lost) {
      this.gl.deleteFramebuffer(store.fbo);
      this.gl.deleteTexture(store.cached.tex);
    }
    this.targets.delete(target);
    this.textures.delete(target);
    if (this.lastSrc === target) {
      this.lastSrc = null;
      this.last = undefined;
    }
  }

  /** A target's framebuffer and texture, created on first use. */
  private targetStore(target: RenderTarget): { fbo: WebGLFramebuffer; cached: CachedTexture } {
    let store = this.targets.get(target);
    if (store) return store;
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("WebGL2: could not create a render target");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, target.width, target.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.wrap();
    const previous = this.target ? (this.targets.get(this.target)?.fbo ?? null) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    // Start transparent, not with whatever the driver left in that memory.
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (scissor) gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
    // Rendered contents are already premultiplied, and stored bottom row first.
    store = { fbo, cached: { tex, iw: 1 / target.width, ih: -1 / target.height, v0: 1 } };
    this.targets.set(target, store);
    this.textures.set(target, store.cached);
    return store;
  }

  private copyPipeline(quad: WebGLBuffer): CopyPipeline {
    const gl = this.gl;
    const program = link(gl, COPY_VERT, COPY_FRAG);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error("WebGL2: could not create buffer");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    const at = (name: string) => gl.getUniformLocation(program, name);
    return {
      program,
      vao,
      buffer,
      view: at("u_view"),
      quad: at("u_quad"),
      origin: at("u_origin"),
      linear: at("u_linear"),
      uv: at("u_uv"),
      color: at("u_color"),
      flash: at("u_flash"),
      snap: at("u_snap"),
    };
  }

  private flush(): void {
    if (this.lost) {
      this.count = 0;
      this.unitCount = 0;
      return;
    }
    if (this.count === 0) {
      this.unitCount = 0;
      return;
    }
    const gl = this.gl;
    for (let i = 0; i < this.unitCount; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.units[i] ?? null);
      gl.bindSampler(i, this.unitSmooth[i] ? this.linear : this.nearest);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.count * (STRIDE / 4));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.submitted++;
    this.count = 0;
    this.unitCount = 0;
  }

  private texture(src: TextureSource): CachedTexture {
    const hit = this.textures.get(src);
    if (hit) return hit;
    if (src instanceof RenderTarget) return this.targetStore(src).cached;
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL2: could not create texture");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.wrap();
    const w = "naturalWidth" in src ? src.naturalWidth : src.width;
    const h = "naturalHeight" in src ? src.naturalHeight : src.height;
    const cached = { tex, iw: 1 / w, ih: 1 / h, v0: 0 };
    this.textures.set(src, cached);
    // Unit 0 is now bound to this texture; the next flush rebinds whatever the batch needs.
    return cached;
  }

  /** Texture parameters for the bound texture. Filtering comes from the samplers; this keeps the texture complete without them. */
  private wrap(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private applyBlend(): void {
    const gl = this.gl;
    if (this.blend === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

function sampler(gl: WebGL2RenderingContext, filter: number): WebGLSampler {
  const s = gl.createSampler();
  if (!s) throw new Error("WebGL2: could not create sampler");
  gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, filter);
  gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, filter);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL2: could not create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL2 shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program = gl.createProgram();
  const shaders = [compile(gl.VERTEX_SHADER, vs), compile(gl.FRAGMENT_SHADER, fs)];
  for (const shader of shaders) gl.attachShader(program, shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program: ${gl.getProgramInfoLog(program)}`);
  // The linked program keeps the compiled code; the shader objects can go.
  for (const shader of shaders) gl.deleteShader(shader);
  return program;
}
