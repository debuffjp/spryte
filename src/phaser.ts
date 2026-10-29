/**
 * spryte inside a Phaser 4 game: an `Extern` game object draws with spryte in Phaser's own frame and depth order,
 * on the WebGL2 context the game runs on. Phaser makes a WebGL1 context by itself, so the game is created on one
 * from `createPhaserContext()`. Nothing here depends on Phaser: the types describe the parts of Phaser 4 it touches.
 *
 * ```ts
 * import { createPhaserContext, spryteExtern } from "spryte/phaser";
 *
 * const game = new Phaser.Game({ type: Phaser.WEBGL, ...createPhaserContext(), scene: Bullets });
 * class Bullets extends Phaser.Scene {
 *   create() {
 *     spryteExtern(this.add.extern().setDepth(5), (draw) => draw.sprites(bullet, positions, count));
 *   }
 * }
 * ```
 */
import type { Draw } from "./draw.js";
import { type BorrowedTexture, createSharedRenderer, type SharedRenderer, type SharedRendererOptions } from "./shared.js";

export interface PhaserDrawingContext {
  framebuffer: { webGLFramebuffer: WebGLFramebuffer | null } | null;
  width: number;
  height: number;
  /** Phaser's cached GL state for this destination: framebuffer, viewport, scissor, stencil, blend, colour mask. */
  state: unknown;
}

export interface PhaserWebGLRenderer {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  glWrapper: { update(state: unknown, force?: boolean): void };
}

export interface PhaserMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** The parts of `Phaser.GameObjects.Extern` the helper uses. */
export interface PhaserExtern {
  render(
    renderer: PhaserWebGLRenderer,
    drawingContext: PhaserDrawingContext,
    calcMatrix: PhaserMatrix,
    displayList?: unknown,
    displayListIndex?: number,
  ): void;
  once?(event: string, fn: () => void): unknown;
  /** Its scene, whose texture manager lends spryte the textures Phaser already uploaded. */
  scene?: { sys: { textures: PhaserTextureManager } };
}

/** The parts of `Phaser.Textures.TextureManager` the helper reads. */
export interface PhaserTextureManager {
  getTextureKeys(): string[];
  get(key: string): { source: PhaserTextureSource[] };
}

interface PhaserTextureSource {
  image: unknown;
  glTexture: { webGLTexture: WebGLTexture | null; width: number; height: number; flipY: boolean; pma: boolean } | null;
}

/**
 * A lookup of Phaser's texture for an image it loaded (`this.textures.get(key).getSourceImage()`). spryte asks every
 * frame, so the image's source is remembered and only its GL texture, which Phaser may re-create, is read fresh.
 * Unpremultiplied textures would blend differently from spryte's own uploads, so those get spryte's copy.
 */
function phaserTextures(textures: PhaserTextureManager): (src: object) => BorrowedTexture | null {
  const sources = new WeakMap<object, PhaserTextureSource>();
  const find = (src: object) => {
    for (const key of textures.getTextureKeys()) for (const s of textures.get(key).source) if (s.image === src) return s;
    return undefined;
  };
  return (src) => {
    let s = sources.get(src);
    if (!s) {
      s = find(src);
      if (!s) return null;
      sources.set(src, s);
    }
    const t = s.glTexture;
    return t?.webGLTexture && t.pma ? { texture: t.webGLTexture, width: t.width, height: t.height, flipY: t.flipY } : null;
  };
}

export interface PhaserSpryte {
  /** The `Draw`, from the first frame on (spryte is created in the Extern's first render, where Phaser expects GL state to change). */
  readonly draw: Draw | null;
  /** Free spryte's GPU objects. Called for you when the Extern is destroyed. */
  dispose(): void;
}

/**
 * Draw with spryte in an `Extern`'s slot: `render` is called each frame with a `Draw` whose transform is the
 * Extern's `calcMatrix` (the camera, and any Container it's in), so world coordinates are Phaser's. Filters on the
 * Extern or its camera, camera viewports and `Stencil` masks apply, since spryte draws into Phaser's drawing context
 * under its state. Images Phaser loaded draw from Phaser's own GPU textures, with no second upload. The game must
 * run on a WebGL2 context (`createPhaserContext`).
 */
export function spryteExtern(extern: PhaserExtern, render: (draw: Draw) => void, options: SharedRendererOptions = {}): PhaserSpryte {
  let shared: SharedRenderer | null = null;
  extern.render = (renderer, context, m) => {
    const gl = renderer.gl;
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext))
      throw new Error("spryte/phaser: Phaser is on a WebGL1 context. Create the game with `...createPhaserContext()` in its config.");
    const textures = extern.scene?.sys.textures;
    shared ??= createSharedRenderer(gl, textures ? { borrow: phaserTextures(textures), ...options } : options);
    // Phaser's full state for this destination, forced: it has only reset blend, VAO and textures for the Extern.
    renderer.glWrapper.update(context.state, true);
    shared.target(context.framebuffer?.webGLFramebuffer ?? null, context.width, context.height);
    const draw = shared.draw;
    draw.begin(null, context.width, context.height, 1);
    draw.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    render(draw);
    draw.end();
  };
  const dispose = () => {
    shared?.draw.dispose();
    shared = null;
  };
  extern.once?.("destroy", dispose);
  return {
    get draw() {
      return shared?.draw ?? null;
    },
    dispose,
  };
}

/**
 * A WebGL2 context for Phaser to run on, with its shaders translated to GLSL ES 3.00 (`shimShaders`). Spread the
 * result into the game config, with `type: Phaser.WEBGL`. `attributes` are the context's, defaulting to Phaser's
 * (opaque, antialiased, premultiplied, with a stencil buffer, on the high-performance GPU). `gl` is the context;
 * `context` is the same object, typed to fit whatever Phaser's config declares (a 2D context, in 4.2.1).
 */
export function createPhaserContext(
  canvas: HTMLCanvasElement = document.createElement("canvas"),
  attributes: WebGLContextAttributes = {},
): { canvas: HTMLCanvasElement; context: never; gl: WebGL2RenderingContext } {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    premultipliedAlpha: true,
    stencil: true,
    powerPreference: "high-performance",
    ...attributes,
  });
  if (!gl) throw new Error("spryte/phaser: WebGL2 is unavailable in this browser");
  shimShaders(gl);
  return { canvas, context: gl as never, gl };
}

/**
 * Translate every GLSL ES 1.00 shader compiled on `gl` to ES 3.00. Phaser 4's shaders are ES 1.00, and on a WebGL2
 * context the ones that use derivatives (`Gradient`, noise objects with `noiseNormalMap`, `smoothPixelArt`) fail
 * to compile, since `OES_standard_derivatives` is a WebGL1 extension (Phaser 4.2.1). Install it before
 * `new Phaser.Game`; `createPhaserContext` does. Shaders that already declare `#version 300 es` pass through.
 */
export function shimShaders(gl: WebGL2RenderingContext): void {
  const types = new WeakMap<WebGLShader, number>();
  const createShader = gl.createShader.bind(gl);
  gl.createShader = (type: number) => {
    const shader = createShader(type);
    if (shader) types.set(shader, type);
    return shader;
  };
  const shaderSource = gl.shaderSource.bind(gl);
  gl.shaderSource = (shader: WebGLShader, source: string) =>
    shaderSource(shader, /^\s*#version\s+300/.test(source) ? source : toEs300(source, types.get(shader) === gl.FRAGMENT_SHADER));
  // Uniforms and attributes renamed in the source are looked up and bound by their new names.
  const getUniformLocation = gl.getUniformLocation.bind(gl);
  gl.getUniformLocation = (program: WebGLProgram, name: string) => getUniformLocation(program, renameIdentifier(name));
  const getAttribLocation = gl.getAttribLocation.bind(gl);
  gl.getAttribLocation = (program: WebGLProgram, name: string) => getAttribLocation(program, renameIdentifier(name));
  const bindAttribLocation = gl.bindAttribLocation.bind(gl);
  gl.bindAttribLocation = (program: WebGLProgram, index: number, name: string) =>
    bindAttribLocation(program, index, renameIdentifier(name));
}

/** Identifiers that are keywords or built-in functions in ES 3.00 but were free in ES 1.00. */
const RESERVED = /\b(sample|centroid|smooth|layout|patch|uint|uvec[234]|texture)\b/g;

/** A uniform or attribute name (`smooth`, `smooth[0]`, `light.sample`) as `toEs300` renamed it. */
function renameIdentifier(name: string): string {
  return name.replace(RESERVED, "$1_");
}

/** @internal GLSL ES 1.00 to 3.00, for the constructs Phaser's shaders use. Exported for tests. */
export function toEs300(source: string, fragment: boolean): string {
  let out = source
    .replace(/^[ \t]*#version\s+100.*$/m, "")
    .replace(/^[ \t]*#extension\s+GL_(OES_standard_derivatives|EXT_shader_texture_lod)\b.*$/gm, "")
    .replace(RESERVED, "$1_")
    .replace(/\btexture(2D|Cube)(Lod|Proj)?(EXT)?\b/g, (_, _dim: string, fn?: string) => (fn ? `texture${fn}` : "texture"));
  if (fragment) out = out.replace(/\bvarying\b/g, "in").replace(/\bgl_FragColor\b/g, "spryte_FragColor");
  else out = out.replace(/\battribute\b/g, "in").replace(/\bvarying\b/g, "out");
  return `#version 300 es\n${fragment ? "out highp vec4 spryte_FragColor;\n" : ""}${out}`;
}
