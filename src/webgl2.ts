import type { Backend, BlendMode, ClipRect, Matrix, RawContext, TextureSource } from "./backend.js";
import { type CopySpec, copyAt, frameAt, placeAt } from "./copies.js";
import type { Frame, SpriteDrawOptions } from "./draw.js";
import type { Shader } from "./shader.js";
import type { ShapeBuffer } from "./shapes.js";
import { RenderTarget } from "./target.js";

/** Texture units sampled per batch. 8 is guaranteed on every WebGL2 implementation's fragment stage (min 16). */
const UNITS = 8;

/** Added to an instance's texture unit: a sprite (`SPRITE`), and one whose position is already whole pixels (`PLACED`). */
const SPRITE = 16;
const PLACED = 32;

/**
 * One instance format for quads and sprites, so both share a batch. A quad carries its finished matrix and UVs.
 * A sprite carries `draw.sprite`'s own values, and the vertex shader does the transform algebra under the
 * batch's transform (`u_linear`, `u_mt`), which saves the CPU a cos, a sin and a matrix product per sprite.
 */
const VERT = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_0;      // quad: a, c, e, b    sprite: x, y, rotation, scaleX
layout(location=2) in vec4 a_1;      // quad: d, f, u0, v0  sprite: scaleY, originX, originY, flash
layout(location=3) in vec4 a_2;      // quad: u1, v1, flash sprite: frame x, y, w, h (pixels)
layout(location=4) in float a_flags; // texture unit, + ${SPRITE} for a sprite, + ${PLACED} when x, y are snapped pixels
layout(location=5) in vec4 a_color;  // normalised RGBA
uniform vec2 u_view;
uniform vec4 u_linear;               // the batch's transform, for sprites
uniform vec2 u_mt;
uniform vec3 u_texinfo[${UNITS}];    // 1 / width, 1 / height (negative for targets), v at the top row, per unit
out highp vec2 v_uv;
out vec4 v_color;
out float v_flash;
flat out int v_unit;
void main() {
  int flags = int(a_flags + 0.5);
  int unit = flags & 7;
  vec2 p;
  if ((flags & ${SPRITE}) == 0) {
    p = vec2(dot(a_0.xyz, vec3(a_corner, 1.0)), dot(vec3(a_0.w, a_1.xy), vec3(a_corner, 1.0)));
    v_uv = mix(a_1.zw, a_2.xy, a_corner);
    v_flash = a_2.z;
  } else {
    float cs = cos(a_0.z);
    float sn = sin(a_0.z);
    vec2 ab = vec2(cs, sn) * a_0.w;
    vec2 cd = vec2(-sn, cs) * a_1.x;
    vec2 size = a_2.zw;
    mat2 M = mat2(u_linear.xy, u_linear.zw);
    vec2 e = a_0.xy;
    if ((flags & ${PLACED}) == 0) {
      vec2 off = -a_1.yz * size;
      e = M * (ab * off.x + cd * off.y + a_0.xy) + u_mt;
    }
    p = (M * ab) * (size.x * a_corner.x) + (M * cd) * (size.y * a_corner.y) + e;
    vec3 t = u_texinfo[unit];
    v_uv = vec2((a_2.x + a_corner.x * size.x) * t.x, t.z + (a_2.y + a_corner.y * size.y) * t.y);
    v_flash = a_1.w;
  }
  vec2 clip = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = vec4(a_color.rgb * a_color.a, a_color.a);
  v_unit = unit;
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

/**
 * Copies with per-copy scale, rotation and colour (`draw.sprites` with `each`). The same algebra as
 * `draw.sprite`, run per vertex; absent attributes read constant defaults (scale 1, rotation 0, white).
 */
const EACH_VERT = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
layout(location=2) in float a_scale;
layout(location=3) in float a_rot;
layout(location=4) in uint a_color;
layout(location=5) in vec4 a_uv;    // this copy's frame in texture space
layout(location=6) in vec2 a_size;  // this copy's frame size in pixels
uniform vec2 u_view;
uniform vec4 u_linear;  // current transform, linear part
uniform vec2 u_mt;      // current transform, translation
uniform vec2 u_origin;  // anchor as a fraction of the frame size
uniform vec2 u_scale;
uniform float u_rot;
uniform vec4 u_color;   // shared tint × alpha, straight
uniform float u_snap;
out highp vec2 v_uv;
out vec4 v_color;
void main() {
  float r = u_rot + a_rot;
  float cs = cos(r);
  float sn = sin(r);
  vec2 s = u_scale * a_scale;
  vec2 ab = vec2(cs * s.x, sn * s.x);
  vec2 cd = vec2(-sn * s.y, cs * s.y);
  vec2 offset = -u_origin * a_size;
  vec2 l = ab * offset.x + cd * offset.y + a_pos;
  mat2 M = mat2(u_linear.xy, u_linear.zw);
  vec2 e = M * l + u_mt;
  // Like sprite(): unrotated copies land on whole pixels, decided per copy.
  if (u_snap > 0.5 && r == 0.0) e = floor(e + 0.5);
  vec2 p = (M * ab) * (a_size.x * a_corner.x) + (M * cd) * (a_size.y * a_corner.y) + e;
  vec2 clip = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = mix(a_uv.xy, a_uv.zw, a_corner);
  vec4 each = vec4(float(a_color >> 24u), float((a_color >> 16u) & 255u), float((a_color >> 8u) & 255u), float(a_color & 255u)) / 255.0;
  vec4 c = u_color * each;
  v_color = vec4(c.rgb * c.a, c.a);
}`;

const EACH_FRAG = `#version 300 es
precision mediump float;
in highp vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
uniform float u_flash;
out vec4 outColor;
void main() {
  vec4 t = texture(u_tex, v_uv) * v_color;
  outColor = vec4(mix(t.rgb, vec3(t.a), u_flash), t.a);
}`;

/** The fragment stage around a custom `effect()` when it runs on per-copy sprites: one texture, flash uniform. */
const EACH_FRAG_HEADER = `#version 300 es
precision mediump float;
in highp vec2 v_uv;
in vec4 v_color;
uniform sampler2D u_tex;
uniform float u_flash;
out vec4 outColor;
vec4 source(vec2 uv) { return texture(u_tex, uv); }
`;

const EACH_FRAG_MAIN = `
void main() {
  vec4 t = effect(v_color, v_uv);
  outColor = vec4(mix(t.rgb, vec3(t.a), u_flash), t.a);
}`;

/**
 * Tessellated shapes (`polygon`, `polyline`, `roundRect`, `ring`) as indexed triangles with edge coverage.
 * Sprites drawn while shapes are pending join the same batch as textured quads, so UI that alternates panels
 * and icons stays one draw call. The fragment stage is the sprite program's.
 */
const SHAPE_VERT = `#version 300 es
layout(location=0) in vec4 a_posuv;   // x, y, u, v
layout(location=1) in vec4 a_color;   // normalised RGBA
layout(location=2) in vec4 a_extra;   // coverage, flash, texture unit / 255 (255: none)
uniform vec2 u_view;
out highp vec2 v_uv;
out vec4 v_color;
out float v_flash;
flat out int v_unit;
void main() {
  vec2 clip = a_posuv.xy / u_view * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_posuv.zw;
  v_color = vec4(a_color.rgb * a_color.a, a_color.a) * a_extra.x;
  v_flash = a_extra.y;
  v_unit = int(a_extra.z * 255.0 + 0.5);
}`;

interface ShapePipeline extends ProgramInfo {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  indices: WebGLBuffer;
}

/** A per-copy program: the built-in one, or a custom shader's effect compiled against it. */
interface EachProgram extends ProgramInfo {
  at: Record<"linear" | "mt" | "origin" | "scale" | "rot" | "color" | "flash" | "snap", WebGLUniformLocation | null>;
}

interface EachPipeline extends EachProgram {
  vao: WebGLVertexArrayObject;
  /** Position, scale, rotation, colour and frame (uv + size) buffers (attribute locations 1–4, 5–6). */
  buffers: WebGLBuffer[];
}

interface EachCustom extends EachProgram {
  locations: Map<string, WebGLUniformLocation | null>;
}

interface CopyPipeline extends ProgramInfo {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  quad: WebGLUniformLocation | null;
  origin: WebGLUniformLocation | null;
  linear: WebGLUniformLocation | null;
  uv: WebGLUniformLocation | null;
  color: WebGLUniformLocation | null;
  flash: WebGLUniformLocation | null;
  snap: WebGLUniformLocation | null;
}

const FRAG_HEADER = `#version 300 es
precision mediump float;
// highp: mediump is fp16 on many mobile GPUs, too coarse to address texels in atlases past ~1024 px.
in highp vec2 v_uv;
in vec4 v_color;
in float v_flash;
flat in int v_unit;
uniform sampler2D u_tex[${UNITS}];
out vec4 outColor;
vec4 source(vec2 uv) {
  ${Array.from({ length: UNITS }, (_, i) => `if (v_unit == ${i}) return texture(u_tex[${i}], uv);`).join("\n  ")}
  return vec4(1.0);
}
`;

// Flash: push colour toward white while keeping alpha (premultiplied).
const FRAG_MAIN = `
void main() {
  vec4 t = effect(v_color, v_uv);
  outColor = vec4(mix(t.rgb, vec3(t.a), v_flash), t.a);
}`;

const FRAG = `${FRAG_HEADER}vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }${FRAG_MAIN}`;

/** Uniform locations of a per-copy program (`EACH_VERT` plus any fragment stage). */
function eachProgram(gl: WebGL2RenderingContext, program: WebGLProgram): EachProgram {
  const u = (name: string) => gl.getUniformLocation(program, name);
  return {
    program,
    view: u("u_view"),
    w: -1,
    h: -1,
    at: {
      linear: u("u_linear"),
      mt: u("u_mt"),
      origin: u("u_origin"),
      scale: u("u_scale"),
      rot: u("u_rot"),
      color: u("u_color"),
      flash: u("u_flash"),
      snap: u("u_snap"),
    },
  };
}

/** A linked program and the view size last uploaded to it, so `u_view` is only sent when it changes. */
interface ProgramInfo {
  program: WebGLProgram;
  view: WebGLUniformLocation | null;
  w: number;
  h: number;
}

/** A program on the shared instance format: `ProgramInfo` plus the uniforms sprites read. */
interface BatchProgram extends ProgramInfo {
  linear: WebGLUniformLocation | null;
  mt: WebGLUniformLocation | null;
  texinfo: WebGLUniformLocation | null;
}

interface CustomProgram extends BatchProgram {
  locations: Map<string, WebGLUniformLocation | null>;
}

/** Floats per instance before the 4-byte colour. */
const FLOATS = 13;
const STRIDE = FLOATS * 4 + 4;

interface CachedTexture {
  tex: WebGLTexture;
  /** 1 / width and ±1 / height, so UV maths multiplies instead of divides. */
  iw: number;
  ih: number;
  /** v at the image's top row: 0, or 1 for render targets, which WebGL stores bottom row first (`ih` is then negative). */
  v0: number;
  /** The host engine's texture (`borrow`): spryte samples it but never uploads to or deletes it. */
  borrowed?: true;
}

/** Sources spryte uploads itself: every `TextureSource` but a render target. */
export type ImageSource = HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

/** A texture another engine on the same context already holds for a source, to draw instead of uploading a copy. */
export interface BorrowedTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  /** Stored bottom row first (`UNPACK_FLIP_Y_WEBGL`), as Phaser stores images. */
  flipY: boolean;
}

/** Instanced, multi-texture WebGL2 sprite batcher behind the `draw` API. */
export class WebGL2Backend implements Backend {
  readonly kind = "webgl2" as const;
  readonly raw: RawContext;
  protected readonly gl: WebGL2RenderingContext;
  private readonly capacity = 16_384;
  private readonly data = new ArrayBuffer(this.capacity * STRIDE);
  private readonly f32 = new Float32Array(this.data);
  private readonly u32 = new Uint32Array(this.data);
  // GPU objects are recreated after a context loss, so they are not readonly.
  private instanceBuffer!: WebGLBuffer;
  private readonly textures = new Map<TextureSource, CachedTexture>();
  private white!: CachedTexture;
  /** Filtering lives in sampler objects, so one upload serves smooth and pixelated draws. */
  private nearest!: WebGLSampler;
  private linear!: WebGLSampler;
  private main!: BatchProgram;
  /** The program sprite batches draw with: `main`, or a custom shader's inside `withShader`. */
  protected active!: BatchProgram;
  private shader: Shader | null = null;
  private readonly customs = new Map<Shader, CustomProgram>();
  /** Custom shaders compiled for per-copy sprites, so effects keep the instanced path. */
  private readonly eachCustoms = new Map<Shader, EachCustom>();
  protected vao!: WebGLVertexArrayObject;
  private quadBuffer!: WebGLBuffer;
  private copyPipe!: CopyPipeline;
  private each!: EachPipeline;
  /** Made on the first shape, so apps that draw none never build them. */
  private shapePipe: ShapePipeline | undefined;
  private shapes: ShapeBuffer | undefined;
  private stagingScale = new Float32Array(0);
  private stagingRot = new Float32Array(0);
  private stagingFrame = new Float32Array(0);
  private staging = new Float32Array(0);
  private readonly targets = new Map<RenderTarget, { fbo: WebGLFramebuffer; cached: CachedTexture }>();
  /** Where drawing goes: a render target, or null for the canvas. */
  protected target: RenderTarget | null = null;
  /** Height in pixels of the current destination, for flipping scissor rectangles. */
  protected outH = 1;
  private viewW = 1;
  private viewH = 1;
  /** True between webglcontextlost and webglcontextrestored: drawing is skipped. */
  protected lost = false;
  protected readonly onLost = (e: Event) => {
    // preventDefault tells the browser we will handle restoration.
    e.preventDefault();
    this.lost = true;
    this.armed = false;
  };
  protected readonly onRestored = () => {
    // Every GPU object died with the context. Sources are still in memory, so textures re-upload lazily.
    // Render targets come back blank. Custom shaders recompile on next use.
    const shader = this.shader;
    this.customs.clear();
    this.eachCustoms.clear();
    this.textures.clear();
    this.targets.clear();
    this.target = null;
    this.lastSrc = null;
    this.last = undefined;
    this.count = 0;
    this.unitCount = 0;
    this.sprites = false;
    this.armed = false;
    this.setup();
    this.lost = false;
    if (shader) this.setShader(shader);
  };
  private readonly units: (WebGLTexture | null)[] = new Array(UNITS).fill(null);
  private readonly unitSmooth: boolean[] = new Array(UNITS).fill(false);
  private unitCount = 0;
  private lastUnit = 0;
  private lastSmooth = false;
  private lastSrc: TextureSource | null = null;
  private last: CachedTexture | undefined;
  private count = 0;
  /** True when the pending batch holds sprites, which read the batch's transform `bm` and `unitInfo`. */
  private sprites = false;
  private readonly bm: Matrix = [1, 0, 0, 1, 0, 0];
  private readonly unitInfo: (CachedTexture | undefined)[] = new Array(UNITS).fill(undefined);
  /** The source each unit was assigned for, so a sprite can find its unit without the texture lookup. */
  private readonly unitSrc: (TextureSource | null)[] = new Array(UNITS).fill(null);
  /**
   * True while a sprite batch is open under the transform version `bver`, with no shapes pending: the next sprite
   * under that version only needs its unit found. Everything that ends or changes the batch clears it.
   */
  private armed = false;
  private bver = -1;
  private readonly texInfo = new Float32Array(UNITS * 3);
  private readonly fallback: Matrix = [1, 0, 0, 1, 0, 0];
  private blend: BlendMode | "mask" = "normal";
  private submitted = 0;

  /** Draw calls this frame, counting the batch still pending (read before `end()` flushes it). */
  get drawCalls(): number {
    return this.submitted + (this.count > 0 || (this.shapes?.count ?? 0) > 0 ? 1 : 0);
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
    this.main = batchProgram(gl, program);
    this.active = this.main;
    this.shader = null;
    gl.useProgram(program);
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
    attr(1, 4, gl.FLOAT, false, 0);
    attr(2, 4, gl.FLOAT, false, 16);
    attr(3, 4, gl.FLOAT, false, 32);
    attr(4, 1, gl.FLOAT, false, 48);
    attr(5, 4, gl.UNSIGNED_BYTE, true, 52);

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
    this.copyPipe = this.copyPipeline(quad);
    this.each = this.eachPipeline(quad);
    this.shapePipe = undefined;
    gl.useProgram(program);
    gl.bindVertexArray(this.vao);
  }

  begin(clear: number | null, width: number, height: number): void {
    if (this.lost) return;
    const gl = this.gl;
    this.target = null;
    this.bindOutput();
    if (this.active !== this.main) this.setShader(null);
    this.viewW = width;
    this.viewH = height;
    if (clear !== null) {
      // The canvas is premultiplied, so a see-through clear colour is premultiplied too (opaque colours are unchanged).
      const a = (clear & 0xff) / 255;
      gl.clearColor(((clear >>> 24) / 255) * a, (((clear >>> 16) & 0xff) / 255) * a, (((clear >>> 8) & 0xff) / 255) * a, a);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.submitted = 0;
  }

  /** The frame's destination: the canvas. Shared mode draws into the host's framebuffer instead. */
  protected outputFramebuffer(): WebGLFramebuffer | null {
    return null;
  }

  /** Bind the frame's destination with the viewport sized to it. */
  protected bindOutput(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outputFramebuffer());
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.outH = gl.drawingBufferHeight;
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
    // Custom effects run in the sprite program, so they end a mixed shape batch.
    if (this.shader && this.shapes && this.shapes.count > 0) this.flushShapes();
    // Fast path: consecutive draws from the same source skip the texture lookup.
    if (src !== null && src === this.target) throw new Error("spryte: can't draw a render target into itself");
    const t = src === null ? this.white : src === this.lastSrc && this.last ? this.last : this.texture(src);
    const sameAsLast = t === this.last;
    this.lastSrc = src;
    this.last = t;
    if (this.count === this.capacity) this.flush();
    const unit = this.unitFor(t, smooth, sameAsLast, src);
    const shapes = this.shapes;
    if (shapes && shapes.count > 0 && !this.shader) {
      // Shapes pending: join their batch instead of breaking it.
      shapes.sprite(
        m,
        sx * t.iw,
        t.v0 + sy * t.ih,
        (sx + sw) * t.iw,
        t.v0 + (sy + sh) * t.ih,
        color === 0xffffffff ? color : bytes(color),
        flash,
        unit,
      );
      return;
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
    f32[f + 7] = t.v0 + sy * t.ih;
    f32[f + 8] = (sx + sw) * t.iw;
    f32[f + 9] = t.v0 + (sy + sh) * t.ih;
    f32[f + 10] = flash;
    f32[f + 12] = unit;
    // Bytes in memory must read R, G, B, A; Uint32 is little-endian.
    this.u32[f + 13] = color === 0xffffffff ? color : bytes(color);
    this.count++;
  }

  sprite(ver: number, m: Matrix, fr: Frame, x: number, y: number, o: SpriteDrawOptions, color: number, smooth: boolean): void {
    const origin = o.origin;
    const ox = origin ? origin[0] : 0.5;
    const oy = origin ? origin[1] : 0.5;
    const sx = (o.scaleX ?? 1) * (o.flipX ? -1 : 1);
    const sy = (o.scaleY ?? 1) * (o.flipY ? -1 : 1);
    const r = o.rotation ?? 0;
    const flash = o.flash ?? 0;
    if (this.armed && ver === this.bver && this.count < this.capacity) {
      const src = fr.image;
      const us = this.unitSrc;
      const sm = this.unitSmooth;
      for (let i = 0; i < this.unitCount; i++)
        if (us[i] === src && sm[i] === smooth) {
          this.write(i, m, fr, x, y, ox, oy, sx, sy, r, color, flash, smooth);
          return;
        }
    }
    this.place(m, fr, x, y, ox, oy, sx, sy, r, color, flash, smooth);
    const bm = this.bm;
    this.armed =
      this.sprites &&
      !(this.shapes && this.shapes.count > 0) &&
      m[0] === bm[0] &&
      m[1] === bm[1] &&
      m[2] === bm[2] &&
      m[3] === bm[3] &&
      m[4] === bm[4] &&
      m[5] === bm[5];
    this.bver = ver;
  }

  /** The full path for a sprite: falls back to a quad, joins shapes, assigns units, starts the batch transform. */
  private place(
    m: Matrix,
    fr: Frame,
    x: number,
    y: number,
    ox: number,
    oy: number,
    sx: number,
    sy: number,
    r: number,
    color: number,
    flash: number,
    smooth: boolean,
  ): void {
    if (this.lost) return;
    const bm = this.bm;
    const shapes = this.shapes;
    // A sprite under a different transform than the batch's, or joining pending shapes, goes as a quad: same batch.
    if (
      (this.sprites && (m[0] !== bm[0] || m[1] !== bm[1] || m[2] !== bm[2] || m[3] !== bm[3] || m[4] !== bm[4] || m[5] !== bm[5])) ||
      (shapes && shapes.count > 0 && !this.shader)
    ) {
      const q = this.fallback;
      placeAt(m, fr.w, fr.h, x, y, ox, oy, sx, sy, r, q);
      if (!smooth && q[1] === 0 && q[2] === 0) {
        q[4] = Math.round(q[4]);
        q[5] = Math.round(q[5]);
      }
      this.quad(q, fr.image, fr.x, fr.y, fr.w, fr.h, color, flash, smooth);
      return;
    }
    // Under a custom shader shapes don't take sprites: draw them first, keeping order.
    if (shapes && shapes.count > 0) this.flushShapes();
    const src = fr.image;
    if (src === this.target) throw new Error("spryte: can't draw a render target into itself");
    const t = src === this.lastSrc && this.last ? this.last : this.texture(src);
    const sameAsLast = t === this.last;
    this.lastSrc = src;
    this.last = t;
    if (this.count === this.capacity) this.flush();
    const unit = this.unitFor(t, smooth, sameAsLast, src);
    if (!this.sprites) {
      for (let i = 0; i < 6; i++) bm[i] = m[i] as number;
      this.sprites = true;
    }
    this.write(unit, m, fr, x, y, ox, oy, sx, sy, r, color, flash, smooth);
  }

  /** One sprite instance at the batch's next slot. */
  private write(
    unit: number,
    m: Matrix,
    fr: Frame,
    x: number,
    y: number,
    ox: number,
    oy: number,
    sx: number,
    sy: number,
    r: number,
    color: number,
    flash: number,
    smooth: boolean,
  ): void {
    const f = this.count * (STRIDE / 4);
    const { f32 } = this;
    let flags = unit + SPRITE;
    if (!smooth && r === 0 && m[1] === 0 && m[2] === 0) {
      // Unrotated pixel art: whole pixels, rounded here in double precision as quad callers do.
      const lx = sx * (-ox * fr.w) + x;
      const ly = sy * (-oy * fr.h) + y;
      f32[f] = Math.round(m[0] * lx + m[4]);
      f32[f + 1] = Math.round(m[3] * ly + m[5]);
      flags += PLACED;
    } else {
      f32[f] = x;
      f32[f + 1] = y;
    }
    f32[f + 2] = r;
    f32[f + 3] = sx;
    f32[f + 4] = sy;
    f32[f + 5] = ox;
    f32[f + 6] = oy;
    f32[f + 7] = flash;
    f32[f + 8] = fr.x;
    f32[f + 9] = fr.y;
    f32[f + 10] = fr.w;
    f32[f + 11] = fr.h;
    f32[f + 12] = flags;
    this.u32[f + 13] = color === 0xffffffff ? color : bytes(color);
    this.count++;
  }

  /** The batch's texture unit for `t` with this filtering, adding one (or flushing a full batch first). */
  private unitFor(t: CachedTexture, smooth: boolean, sameAsLast: boolean, src: TextureSource | null): number {
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
      this.unitInfo[unit] = t;
      this.unitSrc[unit] = src;
    }
    this.lastUnit = unit;
    this.lastSmooth = smooth;
    return unit;
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
    const c = this.copyPipe;
    gl.useProgram(c.program);
    gl.bindVertexArray(c.vao);
    this.syncView(c);
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
    gl.useProgram(this.active.program);
    gl.bindVertexArray(this.vao);
  }

  copies(c: CopySpec): void {
    if (this.lost || c.count <= 0) return;
    if (c.mixed) {
      // Frames across images need the sprite program's texture units: one quad per copy.
      const q: Matrix = [1, 0, 0, 1, 0, 0];
      for (let i = 0; i < c.count; i++) {
        const f = frameAt(c, i);
        if (f.image === this.target) throw new Error("spryte: can't draw a render target into itself");
        const color = copyAt(c, i, q, f);
        this.quad(q, f.image, f.x, f.y, f.w, f.h, color, c.flash, c.smooth);
      }
      return;
    }
    const src = c.frame.image;
    if (src === this.target) throw new Error("spryte: can't draw a render target into itself");
    this.flush();
    const gl = this.gl;
    const tex = src === this.lastSrc && this.last ? this.last : this.texture(src);
    this.lastSrc = src;
    this.last = tex;
    const p = this.each;
    const shader = this.shader;
    const prog: EachProgram = shader ? this.eachCustom(shader) : p;
    const at = prog.at;
    gl.useProgram(prog.program);
    gl.bindVertexArray(p.vao);
    this.syncView(prog);
    if (shader) this.syncUniforms(shader, prog as EachCustom);
    const m = c.m;
    gl.uniform4f(at.linear, m[0], m[1], m[2], m[3]);
    gl.uniform2f(at.mt, m[4], m[5]);
    gl.uniform2f(at.origin, c.originX, c.originY);
    gl.uniform2f(at.scale, c.scaleX, c.scaleY);
    gl.uniform1f(at.rot, c.rotation);
    const col = c.color;
    gl.uniform4f(at.color, (col >>> 24) / 255, ((col >>> 16) & 0xff) / 255, ((col >>> 8) & 0xff) / 255, (col & 0xff) / 255);
    gl.uniform1f(at.flash, c.flash);
    gl.uniform1f(at.snap, c.snap ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.bindSampler(0, c.smooth ? this.linear : this.nearest);
    const n = c.count;
    const e = c.each;
    // Pointers are set on every call: a field can be its own array, an offset into interleaved records, or absent.
    const bytes = c.stride * 4;
    if (e.stride) {
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buffers[0] as WebGLBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, c.positions as Float32Array, gl.STREAM_DRAW, 0, n * c.stride);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, c.offset * 4);
      gl.enableVertexAttribArray(1);
    } else this.attribute(1, 2, p.buffers[0] as WebGLBuffer, c.positions, n * 2, "staging");
    for (const [loc, field, rest, staging] of [
      [2, e.scale, 1, "stagingScale"],
      [3, e.rotation, 0, "stagingRot"],
    ] as const) {
      if (field === undefined) {
        gl.disableVertexAttribArray(loc);
        gl.vertexAttrib1f(loc, rest);
      } else if (typeof field === "number") {
        gl.bindBuffer(gl.ARRAY_BUFFER, p.buffers[0] as WebGLBuffer);
        gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, bytes, field * 4);
        gl.enableVertexAttribArray(loc);
      } else this.attribute(loc, 1, p.buffers[loc - 1] as WebGLBuffer, field, n, staging);
    }
    const color = e.color;
    if (color === undefined) {
      gl.disableVertexAttribArray(4);
      gl.vertexAttribI4ui(4, 0xffffffff, 0, 0, 0);
    } else {
      if (typeof color === "number") {
        // The record's bits at that offset are read as the packed colour, straight from the same upload.
        gl.bindBuffer(gl.ARRAY_BUFFER, p.buffers[0] as WebGLBuffer);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, bytes, color * 4);
      } else {
        gl.bindBuffer(gl.ARRAY_BUFFER, p.buffers[3] as WebGLBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, color, gl.STREAM_DRAW, 0, n);
        gl.vertexAttribIPointer(4, 1, gl.UNSIGNED_INT, 0, 0);
      }
      gl.enableVertexAttribArray(4);
    }
    if (c.frames) {
      if (this.stagingFrame.length < n * 6) this.stagingFrame = new Float32Array(n * 6);
      const out = this.stagingFrame;
      for (let i = 0; i < n; i++) {
        const f = frameAt(c, i);
        const o = i * 6;
        out[o] = f.x * tex.iw;
        out[o + 1] = tex.v0 + f.y * tex.ih;
        out[o + 2] = (f.x + f.w) * tex.iw;
        out[o + 3] = tex.v0 + (f.y + f.h) * tex.ih;
        out[o + 4] = f.w;
        out[o + 5] = f.h;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buffers[4] as WebGLBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, out, gl.STREAM_DRAW, 0, n * 6);
      gl.enableVertexAttribArray(5);
      gl.enableVertexAttribArray(6);
    } else {
      const f = c.frame;
      gl.disableVertexAttribArray(5);
      gl.disableVertexAttribArray(6);
      gl.vertexAttrib4f(5, f.x * tex.iw, tex.v0 + f.y * tex.ih, (f.x + f.w) * tex.iw, tex.v0 + (f.y + f.h) * tex.ih);
      gl.vertexAttrib2f(6, f.w, f.h);
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    this.submitted++;
    gl.useProgram(this.active.program);
    gl.bindVertexArray(this.vao);
  }

  /** Upload one float attribute: a Float32Array as is, anything else through a reused staging array. */
  private attribute(
    loc: number,
    size: number,
    buffer: WebGLBuffer,
    data: ArrayLike<number>,
    length: number,
    staging: "staging" | "stagingScale" | "stagingRot",
  ): void {
    const gl = this.gl;
    let out: Float32Array;
    if (data instanceof Float32Array) out = data;
    else {
      if (this[staging].length < length) this[staging] = new Float32Array(length);
      out = this[staging];
      for (let i = 0; i < length; i++) out[i] = data[i] as number;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, out, gl.STREAM_DRAW, 0, length);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(loc);
  }

  setBlend(mode: BlendMode | "mask"): void {
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

  update(dst: TextureSource, x: number, y: number, from: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): void {
    // Not uploaded yet: its first use uploads the whole image, which already has this region.
    const cached = this.textures.get(dst);
    // A borrowed texture's contents are the host's to update.
    if (!cached || cached.borrowed) return;
    // Quads already queued this frame read other regions of the texture, so there's no need to flush first.
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cached.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    if (from.width === w && from.height === h) gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, from);
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, from);
    // Unit 0 is now bound to this texture; the next flush rebinds whatever the batch needs.
  }

  invalidate(src: TextureSource): void {
    // A target's texture is its contents: there is nothing to re-upload.
    if (src instanceof RenderTarget) return;
    const cached = this.textures.get(src);
    if (!cached) return;
    this.flush();
    if (!cached.borrowed) this.gl.deleteTexture(cached.tex);
    this.textures.delete(src);
    if (this.lastSrc === src) this.lastSrc = null;
  }

  /** Release every GPU object this backend created, so renderers can be created and destroyed repeatedly. */
  dispose(): void {
    const gl = this.gl;
    gl.canvas.removeEventListener("webglcontextlost", this.onLost);
    gl.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    if (!this.lost) {
      for (const { tex, borrowed } of this.textures.values()) if (!borrowed) gl.deleteTexture(tex);
      gl.deleteTexture(this.white.tex);
      gl.deleteSampler(this.nearest);
      gl.deleteSampler(this.linear);
      gl.deleteBuffer(this.instanceBuffer);
      gl.deleteBuffer(this.quadBuffer);
      gl.deleteVertexArray(this.vao);
      gl.deleteProgram(this.main.program);
      for (const custom of this.customs.values()) gl.deleteProgram(custom.program);
      for (const custom of this.eachCustoms.values()) gl.deleteProgram(custom.program);
      for (const { fbo } of this.targets.values()) gl.deleteFramebuffer(fbo);
      gl.deleteProgram(this.copyPipe.program);
      gl.deleteVertexArray(this.copyPipe.vao);
      gl.deleteBuffer(this.copyPipe.buffer);
      gl.deleteProgram(this.each.program);
      gl.deleteVertexArray(this.each.vao);
      for (const b of this.each.buffers) gl.deleteBuffer(b);
      if (this.shapePipe) {
        gl.deleteProgram(this.shapePipe.program);
        gl.deleteVertexArray(this.shapePipe.vao);
        gl.deleteBuffer(this.shapePipe.buffer);
        gl.deleteBuffer(this.shapePipe.indices);
      }
    }
    this.textures.clear();
    this.targets.clear();
    this.customs.clear();
    this.eachCustoms.clear();
    this.lastSrc = null;
    this.last = undefined;
  }

  setShader(shader: Shader | null): void {
    if (shader === this.shader) return;
    this.flush();
    // Compile before changing any state: a shader that fails to compile throws and leaves the renderer as it was.
    const next = this.lost ? null : shader ? this.custom(shader) : this.main;
    if (this.shader) this.shader.onChange = undefined;
    this.shader = shader;
    if (!next) return;
    this.active = next;
    this.gl.useProgram(next.program);
    // Uniform changes flush the batch drawn with the old values first.
    if (shader) shader.onChange = () => this.flush();
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
    } else this.bindOutput();
    this.target = target;
    this.viewW = width;
    this.viewH = height;
    if (clear !== null) {
      // Premultiplied, like begin().
      const a = (clear & 0xff) / 255;
      gl.clearColor(((clear >>> 24) / 255) * a, (((clear >>> 16) & 0xff) / 255) * a, (((clear >>> 8) & 0xff) / 255) * a, a);
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
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (target.width > max || target.height > max)
      throw new Error(`spryte: render target ${target.width}×${target.height} is larger than this GPU's limit of ${max}×${max}`);
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("WebGL2: could not create a render target");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, target.width, target.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.wrap();
    const previous = this.target ? (this.targets.get(this.target)?.fbo ?? null) : this.outputFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, previous);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error(
        `spryte: render target ${target.width}×${target.height} could not be created (framebuffer status 0x${status.toString(16)})`,
      );
    }
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

  private eachPipeline(quad: WebGLBuffer): EachPipeline {
    const gl = this.gl;
    const program = link(gl, EACH_VERT, EACH_FRAG);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const buffers: WebGLBuffer[] = [];
    for (const [loc, size] of [
      [1, 2],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 4],
    ] as const) {
      const b = gl.createBuffer();
      if (!b) throw new Error("WebGL2: could not create buffer");
      buffers.push(b);
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      if (loc === 4) gl.vertexAttribIPointer(loc, size, gl.UNSIGNED_INT, 0, 0);
      else gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
    }
    // The frame buffer interleaves uv (location 5) and size (location 6): 6 floats per copy.
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 24, 16);
    gl.vertexAttribDivisor(6, 1);
    return { ...eachProgram(gl, program), vao, buffers };
  }

  /** A custom shader's effect compiled against the per-copy vertex stage, on first use. */
  private eachCustom(shader: Shader): EachCustom {
    let p = this.eachCustoms.get(shader);
    if (p) return p;
    const gl = this.gl;
    // #line makes compile errors point at lines in the user's source.
    const program = link(gl, EACH_VERT, `${EACH_FRAG_HEADER}#line 1\n${shader.source}\n${EACH_FRAG_MAIN}`, "custom shader");
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
    p = { ...eachProgram(gl, program), locations: new Map() };
    this.eachCustoms.set(shader, p);
    return p;
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
      w: -1,
      h: -1,
      quad: at("u_quad"),
      origin: at("u_origin"),
      linear: at("u_linear"),
      uv: at("u_uv"),
      color: at("u_color"),
      flash: at("u_flash"),
      snap: at("u_snap"),
    };
  }

  path(
    m: Matrix,
    points: ArrayLike<number>,
    n: number,
    closed: boolean,
    width: number,
    color: number,
    aa: number,
    tessellator: new () => ShapeBuffer,
  ): void {
    if (this.lost) return;
    // Shapes and sprites share one draw order: send queued sprites first.
    if (this.count > 0) this.flush();
    this.shapes ??= new tessellator();
    this.shapes.add(m, points, n, closed, width, bytes(color), aa);
  }

  private flushShapes(): void {
    const s = this.shapes;
    if (!s || s.count === 0) return;
    if (this.lost) {
      s.count = 0;
      s.icount = 0;
      return;
    }
    const gl = this.gl;
    this.shapePipe ??= this.shapePipeline();
    const p = this.shapePipe;
    // Textures of sprites that joined the batch.
    for (let i = 0; i < this.unitCount; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.units[i] ?? null);
      gl.bindSampler(i, this.unitSmooth[i] ? this.linear : this.nearest);
    }
    this.unitCount = 0;
    this.armed = false;
    gl.useProgram(p.program);
    gl.bindVertexArray(p.vao);
    this.syncView(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, s.f32, gl.STREAM_DRAW, 0, s.count * 6);
    // The index buffer is part of the shape VAO's state.
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, s.indices, gl.STREAM_DRAW, 0, s.icount);
    gl.drawElements(gl.TRIANGLES, s.icount, gl.UNSIGNED_INT, 0);
    this.submitted++;
    s.count = 0;
    s.icount = 0;
    gl.useProgram(this.active.program);
    gl.bindVertexArray(this.vao);
  }

  private shapePipeline(): ShapePipeline {
    const gl = this.gl;
    const program = link(gl, SHAPE_VERT, FRAG, "shape");
    gl.useProgram(program);
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_tex"),
      Array.from({ length: UNITS }, (_, i) => i),
    );
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const indices = gl.createBuffer();
    if (!buffer || !indices) throw new Error("WebGL2: could not create shape buffer");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 24, 16);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 24, 20);
    return { program, view: gl.getUniformLocation(program, "u_view"), w: -1, h: -1, vao, buffer, indices };
  }

  protected flush(): void {
    this.flushShapes();
    if (this.lost || this.count === 0) {
      this.count = 0;
      this.unitCount = 0;
      this.armed = false;
      this.sprites = false;
      return;
    }
    const gl = this.gl;
    for (let i = 0; i < this.unitCount; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.units[i] ?? null);
      gl.bindSampler(i, this.unitSmooth[i] ? this.linear : this.nearest);
    }
    const p = this.active;
    this.syncView(p);
    if (this.sprites) {
      const bm = this.bm;
      gl.uniform4f(p.linear, bm[0], bm[1], bm[2], bm[3]);
      gl.uniform2f(p.mt, bm[4], bm[5]);
      const info = this.texInfo;
      for (let i = 0; i < this.unitCount; i++) {
        const t = this.unitInfo[i] as CachedTexture;
        info[i * 3] = t.iw;
        info[i * 3 + 1] = t.ih;
        info[i * 3 + 2] = t.v0;
      }
      gl.uniform3fv(p.texinfo, info);
      this.sprites = false;
    }
    if (this.shader) this.syncUniforms(this.shader, p as CustomProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.count * (STRIDE / 4));
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.submitted++;
    this.count = 0;
    this.unitCount = 0;
    this.armed = false;
  }

  /** Upload `u_view` to a program if the destination size changed since it last drew. The program must be bound. */
  private syncView(p: ProgramInfo): void {
    if (p.w === this.viewW && p.h === this.viewH) return;
    this.gl.uniform2f(p.view, this.viewW, this.viewH);
    p.w = this.viewW;
    p.h = this.viewH;
  }

  private syncUniforms(shader: Shader, p: { program: WebGLProgram; locations: Map<string, WebGLUniformLocation | null> }): void {
    const gl = this.gl;
    for (const [name, value] of shader.uniforms) {
      let loc = p.locations.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(p.program, name);
        p.locations.set(name, loc);
      }
      if (loc === null) continue; // unused uniforms are optimised away by the compiler
      if (typeof value === "number") gl.uniform1f(loc, value);
      else if (value.length === 2) gl.uniform2f(loc, value[0], value[1]);
      else if (value.length === 3) gl.uniform3f(loc, value[0], value[1], value[2]);
      else gl.uniform4f(loc, value[0], value[1], value[2], value[3]);
    }
  }

  private custom(shader: Shader): CustomProgram {
    let p = this.customs.get(shader);
    if (p) return p;
    const gl = this.gl;
    // #line makes compile errors point at lines in the user's source.
    const program = link(gl, VERT, `${FRAG_HEADER}#line 1\n${shader.source}\n${FRAG_MAIN}`, "custom shader");
    gl.useProgram(program);
    gl.uniform1iv(
      gl.getUniformLocation(program, "u_tex"),
      Array.from({ length: UNITS }, (_, i) => i),
    );
    p = { ...batchProgram(gl, program), locations: new Map() };
    this.customs.set(shader, p);
    return p;
  }

  private texture(src: TextureSource): CachedTexture {
    const hit = this.textures.get(src);
    if (hit) return hit;
    if (src instanceof RenderTarget) return this.targetStore(src).cached;
    const w = "naturalWidth" in src ? src.naturalWidth : src.width;
    const h = "naturalHeight" in src ? src.naturalHeight : src.height;
    // An image still loading is 0×0: nothing to upload, and nothing to remember.
    if (w === 0 || h === 0) return this.white;
    const b = this.borrow(src);
    if (b) {
      const cached: CachedTexture = b.flipY
        ? { tex: b.texture, iw: 1 / b.width, ih: -1 / b.height, v0: 1, borrowed: true }
        : { tex: b.texture, iw: 1 / b.width, ih: 1 / b.height, v0: 0, borrowed: true };
      this.textures.set(src, cached);
      return cached;
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("WebGL2: could not create texture");
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.wrap();
    const cached = { tex, iw: 1 / w, ih: 1 / h, v0: 0 };
    this.textures.set(src, cached);
    // Unit 0 is now bound to this texture; the next flush rebinds whatever the batch needs.
    return cached;
  }

  /** Drop borrowed textures, so the next use asks the host again: it may have freed or replaced them since. */
  protected forgetBorrowed(): void {
    for (const [src, cached] of this.textures) if (cached.borrowed) this.textures.delete(src);
    if (this.last?.borrowed) {
      this.lastSrc = null;
      this.last = undefined;
    }
  }

  /** A host's texture for `src`, drawn instead of an upload. None here; `SharedBackend` asks the host. */
  protected borrow(_src: ImageSource): BorrowedTexture | null {
    return null;
  }

  /** Texture parameters for the bound texture. Filtering comes from the samplers; this keeps the texture complete without them. */
  private wrap(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  protected applyBlend(): void {
    const gl = this.gl;
    // Colours are premultiplied, so each mode is one blendFunc.
    const b = this.blend;
    if (b === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else if (b === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
    else if (b === "screen") gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    else if (b === "erase") gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else if (b === "mask") gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
}

/** 0xRRGGBBAA as a Uint32 whose little-endian bytes read R, G, B, A. */
function bytes(color: number): number {
  return ((color & 0xff) << 24) | (((color >>> 8) & 0xff) << 16) | (((color >>> 16) & 0xff) << 8) | (color >>> 24);
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

function batchProgram(gl: WebGL2RenderingContext, program: WebGLProgram): BatchProgram {
  const at = (name: string) => gl.getUniformLocation(program, name);
  return { program, view: at("u_view"), w: -1, h: -1, linear: at("u_linear"), mt: at("u_mt"), texinfo: at("u_texinfo[0]") };
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, label = "WebGL2"): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("WebGL2: could not create shader");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`spryte: ${label} failed to compile:\n${log}`);
    }
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, vs);
  let fragment: WebGLShader;
  try {
    fragment = compile(gl.FRAGMENT_SHADER, fs);
  } catch (e) {
    gl.deleteShader(vertex);
    throw e;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // The linked program keeps the compiled code; the shader objects can go either way.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`spryte: ${label} failed to link:\n${log}`);
  }
  return program;
}
