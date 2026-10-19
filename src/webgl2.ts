import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";

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
out vec2 v_uv;
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

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
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
  /** 1 / width and 1 / height, so UV maths multiplies instead of divides. */
  iw: number;
  ih: number;
  smooth: boolean;
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
  /** True between webglcontextlost and webglcontextrestored: drawing is skipped. */
  private lost = false;
  private readonly onLost = (e: Event) => {
    // preventDefault tells the browser we will handle restoration.
    e.preventDefault();
    this.lost = true;
  };
  private readonly onRestored = () => {
    // Every GPU object died with the context. Sources are still in memory, so textures re-upload lazily.
    this.textures.clear();
    this.lastSrc = null;
    this.last = undefined;
    this.count = 0;
    this.unitCount = 0;
    this.setup();
    this.lost = false;
  };
  private readonly units: (WebGLTexture | null)[] = new Array(UNITS).fill(null);
  private unitCount = 0;
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
    const program = link(gl, VERT, FRAG);
    gl.useProgram(program);
    this.viewLoc = gl.getUniformLocation(program, "u_view");
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_tex"),
      Array.from({ length: UNITS }, (_, i) => i),
    );

    gl.bindVertexArray(gl.createVertexArray());
    const quad = gl.createBuffer();
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
    this.white = { tex: whiteTex, iw: 1, ih: 1, smooth: false };
    this.filter(false);
  }

  begin(clear: number, width: number, height: number): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(this.viewLoc, width, height);
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
    const t = src === null ? this.white : src === this.lastSrc && this.last?.smooth === smooth ? this.last : this.texture(src, smooth);
    this.lastSrc = src;
    this.last = t;
    let unit = this.units.indexOf(t.tex);
    if (unit < 0 || unit >= this.unitCount) {
      if (this.unitCount === UNITS) this.flush();
      unit = this.unitCount++;
      this.units[unit] = t.tex;
    }
    if (this.count === this.capacity) {
      this.flush();
      unit = 0;
      this.units[0] = t.tex;
      this.unitCount = 1;
    }
    const f = this.count * (STRIDE / 4);
    const { f32 } = this;
    f32[f] = m[0];
    f32[f + 1] = m[2];
    f32[f + 2] = m[4];
    f32[f + 3] = m[1];
    f32[f + 4] = m[3];
    f32[f + 5] = m[5];
    f32[f + 6] = sx * t.iw;
    f32[f + 7] = sy * t.ih;
    f32[f + 8] = (sx + sw) * t.iw;
    f32[f + 9] = (sy + sh) * t.ih;
    f32[f + 10] = flash;
    f32[f + 11] = unit;
    // Bytes in memory must read R, G, B, A; Uint32 is little-endian.
    this.u32[f + 12] =
      color === 0xffffffff
        ? color
        : ((color & 0xff) << 24) | (((color >>> 8) & 0xff) << 16) | (((color >>> 16) & 0xff) << 8) | (color >>> 24);
    this.count++;
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
    gl.scissor(rect.x, gl.drawingBufferHeight - rect.y - rect.h, rect.w, rect.h);
  }

  end(): void {
    this.flush();
    this.gl.disable(this.gl.SCISSOR_TEST);
  }

  resize(): void {
    // The viewport is set from drawingBufferWidth/Height at the start of each frame.
  }

  invalidate(src: TextureSource): void {
    const cached = this.textures.get(src);
    if (!cached) return;
    this.flush();
    this.gl.deleteTexture(cached.tex);
    this.textures.delete(src);
    if (this.lastSrc === src) this.lastSrc = null;
  }

  dispose(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (!this.lost) for (const { tex } of this.textures.values()) this.gl.deleteTexture(tex);
    this.textures.clear();
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
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.count * (STRIDE / 4));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.submitted++;
    this.count = 0;
    this.unitCount = 0;
  }

  private texture(src: TextureSource, smooth: boolean): CachedTexture {
    const hit = this.textures.get(src);
    if (hit && hit.smooth === smooth) return hit;
    if (hit) this.invalidate(src);
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL2: could not create texture");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.filter(smooth);
    const w = "naturalWidth" in src ? src.naturalWidth : src.width;
    const h = "naturalHeight" in src ? src.naturalHeight : src.height;
    const cached = { tex, iw: 1 / w, ih: 1 / h, smooth };
    this.textures.set(src, cached);
    // Unit 0 is now bound to this texture; the next flush rebinds whatever the batch needs.
    return cached;
  }

  private filter(smooth: boolean): void {
    const gl = this.gl;
    const f = smooth ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private applyBlend(): void {
    const gl = this.gl;
    if (this.blend === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
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
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program: ${gl.getProgramInfoLog(program)}`);
  return program;
}
