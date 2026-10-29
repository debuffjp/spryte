import { afterEach, describe, expect, it } from "vitest";
import type { Matrix } from "../src/backend.js";
import { type PixiRenderContainer, type PixiRenderer, spryteContainer } from "../src/pixi.js";

/** A WebGL2 context stand-in that passes `instanceof WebGL2RenderingContext`. */
class FakeWebGL2 {}
function fakeGL(calls: string[]): WebGL2RenderingContext {
  const target = Object.assign(Object.create(FakeWebGL2.prototype) as Record<string | symbol, unknown>, {
    canvas: { addEventListener() {}, removeEventListener() {} },
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getParameter: (p: string) => (p === "VIEWPORT" ? Int32Array.of(0, 0, 200, 100) : p === "FRAMEBUFFER_BINDING" ? null : undefined),
    getUniformLocation: () => ({}),
    isContextLost: () => false,
    isEnabled: () => false,
    viewport: (...args: number[]) => calls.push(`viewport:${args.join(",")}`),
    texImage2D: () => calls.push("upload"),
  });
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key;
      return (...args: unknown[]) => (key.startsWith("create") ? { kind: key.slice(6), args } : undefined);
    },
  }) as unknown as WebGL2RenderingContext;
}

const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function pixi(gl: WebGL2RenderingContext | undefined, calls: string[], image?: object) {
  const source = { resource: image, alphaMode: "premultiply-alpha-on-upload" };
  const renderer: PixiRenderer = {
    ...(gl && { gl }),
    globalUniforms: {
      globalUniformData: {
        // Pixi's projection for a 200x100 target: pixels to clip space, y up.
        projectionMatrix: { a: 2 / 200, b: 0, c: 0, d: -2 / 100, tx: -1, ty: 1 },
        worldTransformMatrix: identity,
        offset: { x: 0, y: 0 },
      },
    },
    texture: {
      managedTextures: image ? [source] : [],
      getGlSource: () => {
        calls.push("getGlSource");
        return { texture: { kind: "pixi" } as unknown as WebGLTexture, width: 32, height: 16, target: "TEXTURE_2D" as unknown as number };
      },
      resetState: () => calls.push("reset:texture"),
    },
    shader: { resetState: () => calls.push("reset:shader") },
    geometry: { resetState: () => calls.push("reset:geometry") },
    state: { resetState: () => calls.push("reset:state") },
  };
  const events = new Map<string, () => void>();
  const container: PixiRenderContainer = {
    render: () => {},
    groupTransform: { a: 2, b: 0, c: 0, d: 2, tx: 10, ty: 20 },
    once: (event, fn) => events.set(event, fn),
  };
  return { renderer, container, events };
}

describe("spryteContainer", () => {
  const g = globalThis as { WebGL2RenderingContext?: unknown };
  const real = g.WebGL2RenderingContext;
  afterEach(() => {
    g.WebGL2RenderingContext = real;
  });

  it("draws in Pixi's pixels through its projection, then resets Pixi's GL caches and viewport", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const calls: string[] = [];
    const { renderer, container } = pixi(fakeGL(calls), calls);
    const seen: Matrix[] = [];
    const out = spryteContainer(container, (draw) => {
      seen.push([...draw.m] as Matrix);
    });
    expect(out.spryte.draw).toBeNull();
    (out.render as (r: PixiRenderer) => void)(renderer);
    // Container pixels (2x, at 10, 20) come out as the same viewport pixels.
    expect(seen).toEqual([[2, 0, 0, 2, 10, 20]]);
    expect(calls.slice(-5)).toEqual(["reset:shader", "reset:geometry", "reset:texture", "reset:state", "viewport:0,0,200,100"]);
  });

  it("draws an image Pixi holds from Pixi's texture, asking Pixi every frame", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const calls: string[] = [];
    const image = { naturalWidth: 32, naturalHeight: 16 } as HTMLImageElement;
    const { renderer, container } = pixi(fakeGL(calls), calls, image);
    const out = spryteContainer(container, (draw) => draw.sprite(image, 0, 0));
    const frame = () => (out.render as (r: PixiRenderer) => void)(renderer);
    frame();
    frame();
    expect(calls.filter((c) => c === "getGlSource")).toHaveLength(2);
    // Only spryte's 1x1 white texture is uploaded.
    expect(calls.filter((c) => c === "upload")).toHaveLength(1);
  });

  it("throws a clear error without a WebGL2 context", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const { renderer, container } = pixi(undefined, []);
    const out = spryteContainer(container, () => {});
    expect(() => (out.render as (r: PixiRenderer) => void)(renderer)).toThrow(/preference: "webgl"/);
  });

  it("disposes spryte when the container is destroyed", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const calls: string[] = [];
    const { renderer, container, events } = pixi(fakeGL(calls), calls);
    const out = spryteContainer(container, () => {});
    (out.render as (r: PixiRenderer) => void)(renderer);
    expect(out.spryte.draw).not.toBeNull();
    events.get("destroyed")?.();
    expect(out.spryte.draw).toBeNull();
  });
});
