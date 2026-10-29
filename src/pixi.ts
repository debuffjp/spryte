/**
 * spryte inside a PixiJS v8 app: a `RenderContainer` draws with spryte in Pixi's own frame and scene order, on the
 * WebGL2 context Pixi runs on (its default WebGL renderer). Nothing here depends on PixiJS: the types describe the
 * parts of Pixi v8 it touches.
 *
 * ```ts
 * import { RenderContainer } from "pixi.js";
 * import { spryteContainer } from "spryte/pixi";
 *
 * app.stage.addChild(spryteContainer(new RenderContainer({}), (draw) => draw.sprites(bullet, positions, count)));
 * ```
 */
import type { Draw } from "./draw.js";
import { type BorrowedTexture, createSharedRenderer, type SharedRenderer, type SharedRendererOptions } from "./shared.js";

export interface PixiMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

interface PixiTextureSource {
  resource: unknown;
  alphaMode: string;
}

/** The parts of Pixi's `WebGLRenderer` the helper uses. */
export interface PixiRenderer {
  gl?: WebGLRenderingContext | WebGL2RenderingContext;
  globalUniforms: {
    globalUniformData: { projectionMatrix: PixiMatrix; worldTransformMatrix: PixiMatrix; offset: { x: number; y: number } };
  };
  texture: {
    managedTextures: readonly PixiTextureSource[];
    getGlSource(source: PixiTextureSource): { texture: WebGLTexture; width: number; height: number; target: number };
    resetState(): void;
  };
  shader: { resetState(): void };
  geometry: { resetState(): void };
  state: { resetState(): void };
}

/** The parts of Pixi's `RenderContainer` the helper uses. */
export interface PixiRenderContainer {
  /** Replaced by the helper. `never`, so Pixi's own signature (taking its full `Renderer`) fits. */
  render(renderer: never): void;
  /** Its transform within its render group. */
  readonly groupTransform: PixiMatrix;
  once?(event: string, fn: () => void): unknown;
}

export interface PixiSpryte {
  /** The `Draw`, from the first frame on (spryte is created in the container's first render). */
  readonly draw: Draw | null;
  /** Free spryte's GPU objects. Called for you when the container is destroyed. */
  dispose(): void;
}

/** a∘b: apply `b`, then `a`. */
function mul(a: PixiMatrix, b: PixiMatrix): PixiMatrix {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    tx: a.a * b.tx + a.c * b.ty + a.tx,
    ty: a.b * b.tx + a.d * b.ty + a.ty,
  };
}

/**
 * A lookup of Pixi's texture for an image it has uploaded (`texture.source.resource`). spryte asks every frame:
 * `getGlSource` returns Pixi's current texture and marks it used, so Pixi's texture GC keeps what spryte draws.
 * Textures Pixi stores unpremultiplied get spryte's own copy, since they'd blend differently.
 */
function pixiTextures(renderer: PixiRenderer, gl: WebGL2RenderingContext): (src: object) => BorrowedTexture | null {
  const sources = new WeakMap<object, PixiTextureSource>();
  return (src) => {
    let s = sources.get(src);
    if (!s) {
      s = renderer.texture.managedTextures.find((t) => t.resource === src);
      if (!s) return null;
      sources.set(src, s);
    }
    if (s.alphaMode !== "premultiply-alpha-on-upload" && s.alphaMode !== "premultiplied-alpha") return null;
    const t = renderer.texture.getGlSource(s);
    return t.target === gl.TEXTURE_2D ? { texture: t.texture, width: t.width, height: t.height, flipY: false } : null;
  };
}

/**
 * Draw with spryte in a `RenderContainer`'s slot: `render` is called each frame with a `Draw` whose coordinates are
 * the container's local ones (its transform, its parents' and the render group's apply). Pixi breaks its batch
 * before the slot; afterwards the helper resets Pixi's cached GL state, so Pixi rebinds what it needs. Masks, render
 * textures and filters apply, since spryte draws into whatever Pixi is drawing into under its scissor and stencil.
 * A `RenderContainer` has no bounds, so give a filtered container a `filterArea` (or the container `addBounds`).
 * Images Pixi has uploaded draw from Pixi's own GPU textures. Needs Pixi's WebGL renderer (WebGL2, its default);
 * the container's alpha, tint and blend mode don't apply, so set them in `draw` calls.
 */
export function spryteContainer<T extends PixiRenderContainer>(
  container: T,
  render: (draw: Draw) => void,
  options: SharedRendererOptions = {},
): T & { spryte: PixiSpryte } {
  let shared: SharedRenderer | null = null;
  container.render = (renderer: PixiRenderer) => {
    const gl = renderer.gl;
    if (typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext))
      throw new Error('spryte/pixi: needs Pixi\'s WebGL renderer on WebGL2. Create the app with `preference: "webgl"`.');
    shared ??= createSharedRenderer(gl, { borrow: pixiTextures(renderer, gl), ...options });
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const [vx, vy, vw, vh] = gl.getParameter(gl.VIEWPORT) as Int32Array as unknown as [number, number, number, number];
    // Pixi's projection takes its pixels to clip space; spryte's frame is the viewport in pixels, top-left origin.
    // A filter pass renders an area of the world from `offset`, which Pixi takes off the world transform's translation.
    const { projectionMatrix: projection, worldTransformMatrix: world, offset } = renderer.globalUniforms.globalUniformData;
    const toPixels = { a: vw / 2, b: 0, c: 0, d: -vh / 2, tx: vx + vw / 2, ty: vh / 2 };
    const shifted = { ...world, tx: world.tx - offset.x, ty: world.ty - offset.y };
    const m = mul(mul(mul(toPixels, projection), shifted), container.groupTransform);
    shared.target(fb, vx + vw, vy + vh);
    const draw = shared.draw;
    draw.begin(null, vx + vw, vy + vh, 1);
    draw.transform(m.a, m.b, m.c, m.d, m.tx, m.ty);
    try {
      render(draw);
    } finally {
      draw.end();
      // spryte changed the program, VAO, texture units, blend state and pixel-store flags behind Pixi's caches.
      renderer.shader.resetState();
      renderer.geometry.resetState();
      renderer.texture.resetState();
      renderer.state.resetState();
      gl.viewport(vx, vy, vw, vh);
    }
  };
  const spryte: PixiSpryte = {
    get draw() {
      return shared?.draw ?? null;
    },
    dispose() {
      shared?.draw.dispose();
      shared = null;
    },
  };
  container.once?.("destroyed", spryte.dispose);
  return Object.assign(container, { spryte });
}
