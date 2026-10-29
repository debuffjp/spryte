import { afterEach, describe, expect, it } from "vitest";
import type { Matrix } from "../src/backend.js";
import {
  type PhaserDrawingContext,
  type PhaserExtern,
  type PhaserWebGLRenderer,
  shimShaders,
  spryteExtern,
  toEs300,
} from "../src/phaser.js";

describe("toEs300", () => {
  it("turns an ES 1.00 fragment shader into ES 3.00", () => {
    const src = [
      "#version 100",
      "#extension GL_OES_standard_derivatives : enable",
      "precision mediump float;",
      "varying vec2 v;",
      "uniform sampler2D sample;",
      "void main() { gl_FragColor = texture2D(sample, v) * fwidth(v.x); }",
    ].join("\n");
    const out = toEs300(src, true);
    expect(out.startsWith("#version 300 es\nout highp vec4 spryte_FragColor;\n")).toBe(true);
    expect(out).not.toMatch(/#version 100|#extension|varying|gl_FragColor|texture2D/);
    expect(out).toContain("in vec2 v;");
    expect(out).toContain("uniform sampler2D sample_;");
    expect(out).toContain("spryte_FragColor = texture(sample_, v) * fwidth(v.x);");
  });

  it("turns attributes and varyings of a vertex shader into inputs and outputs", () => {
    const out = toEs300("attribute vec2 a;\nvarying vec2 v;\nvoid main() { v = a; gl_Position = vec4(a, 0.0, 1.0); }", false);
    expect(out).toBe(
      "#version 300 es\n\nin vec2 a;\nout vec2 v;\nvoid main() { v = a; gl_Position = vec4(a, 0.0, 1.0); }".replace("\n\n", "\n"),
    );
  });

  it("maps the LOD and projective texture functions, and identifiers named `texture`", () => {
    const out = toEs300(
      "uniform sampler2D texture; vec4 x = texture2DLodEXT(texture, uv, 0.0) + textureCube(c, d) + texture2DProj(texture, p);",
      true,
    );
    expect(out).toContain("uniform sampler2D texture_; vec4 x = textureLod(texture_, uv, 0.0) + texture(c, d) + textureProj(texture_, p);");
  });
});

describe("shimShaders", () => {
  it("translates by shader type and passes ES 3.00 sources through", () => {
    const sources: string[] = [];
    const shaders = { FRAGMENT_SHADER: 1, VERTEX_SHADER: 2 };
    const gl = {
      ...shaders,
      createShader: (type: number) => ({ type }),
      shaderSource: (_s: unknown, src: string) => sources.push(src),
      getUniformLocation: () => null,
      getAttribLocation: () => -1,
      bindAttribLocation: () => {},
    } as unknown as WebGL2RenderingContext;
    shimShaders(gl);
    const frag = gl.createShader(gl.FRAGMENT_SHADER) as WebGLShader;
    const vert = gl.createShader(gl.VERTEX_SHADER) as WebGLShader;
    gl.shaderSource(frag, "void main() { gl_FragColor = vec4(1.0); }");
    gl.shaderSource(vert, "attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }");
    gl.shaderSource(frag, "#version 300 es\nout vec4 o; void main() { o = vec4(1.0); }");
    expect(sources[0]).toContain("out highp vec4 spryte_FragColor;");
    expect(sources[1]).toBe("#version 300 es\nin vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }");
    expect(sources[2]).toBe("#version 300 es\nout vec4 o; void main() { o = vec4(1.0); }");
  });

  it("looks up and binds renamed uniforms and attributes by their new names", () => {
    const seen: string[] = [];
    const gl = {
      createShader: () => ({}),
      shaderSource: () => {},
      getUniformLocation: (_p: unknown, name: string) => seen.push(name),
      getAttribLocation: (_p: unknown, name: string) => seen.push(name),
      bindAttribLocation: (_p: unknown, _i: number, name: string) => seen.push(name),
    } as unknown as WebGL2RenderingContext;
    shimShaders(gl);
    const program = {} as WebGLProgram;
    gl.getUniformLocation(program, "smooth");
    gl.getUniformLocation(program, "lights[0].sample");
    gl.getUniformLocation(program, "uMainSampler");
    gl.getAttribLocation(program, "texture");
    gl.bindAttribLocation(program, 0, "inPosition");
    expect(seen).toEqual(["smooth_", "lights[0].sample_", "uMainSampler", "texture_", "inPosition"]);
  });
});

/** A WebGL2 context stand-in that passes `instanceof WebGL2RenderingContext`. */
class FakeWebGL2 {}
function fakeGL(): WebGL2RenderingContext {
  const target = Object.assign(Object.create(FakeWebGL2.prototype) as Record<string | symbol, unknown>, {
    canvas: { addEventListener() {}, removeEventListener() {} },
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: () => undefined,
    getUniformLocation: () => ({}),
    isContextLost: () => false,
    isEnabled: () => false,
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

describe("spryteExtern", () => {
  const g = globalThis as { WebGL2RenderingContext?: unknown };
  const real = g.WebGL2RenderingContext;
  afterEach(() => {
    g.WebGL2RenderingContext = real;
  });

  function phaser(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    const updates: unknown[][] = [];
    const renderer: PhaserWebGLRenderer = { gl, glWrapper: { update: (...args: unknown[]) => updates.push(args) } };
    const fb = { webGLFramebuffer: { kind: "phaser" } as unknown as WebGLFramebuffer };
    const context: PhaserDrawingContext = { framebuffer: fb, width: 320, height: 180, state: { phaser: true } };
    const events = new Map<string, () => void>();
    const extern: PhaserExtern = { render: () => {}, once: (event, fn) => events.set(event, fn) };
    return { renderer, context, extern, updates, events, fb };
  }

  it("creates spryte in the first render, under Phaser's state, drawing into its framebuffer with its matrix", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const { renderer, context, extern, updates, fb } = phaser(fakeGL());
    const seen: Matrix[] = [];
    const handle = spryteExtern(extern, (draw) => {
      draw.rect(0, 0, 1, 1, "#fff");
      seen.push([...draw.m] as Matrix);
    });
    expect(handle.draw).toBeNull();
    extern.render(renderer, context, { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 });
    expect(handle.draw).not.toBeNull();
    expect(updates).toEqual([[{ phaser: true }, true]]);
    expect(seen).toEqual([[2, 0, 0, 2, 10, 20]]);
    expect([handle.draw?.backingW, handle.draw?.backingH]).toEqual([320, 180]);
    void fb;
  });

  it("throws a clear error when Phaser is on a WebGL1 context", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const { renderer, context, extern } = phaser({} as WebGLRenderingContext);
    spryteExtern(extern, () => {});
    expect(() => extern.render(renderer, context, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })).toThrow(/WebGL1 context/);
  });

  it("disposes spryte when the Extern is destroyed", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const { renderer, context, extern, events } = phaser(fakeGL());
    const handle = spryteExtern(extern, () => {});
    extern.render(renderer, context, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const draw = handle.draw;
    events.get("destroy")?.();
    expect(handle.draw).toBeNull();
    expect(() => draw?.begin(null, 1, 1, 1)).toThrow();
  });

  it("draws Phaser's texture for an image it loaded, without uploading or deleting it", () => {
    g.WebGL2RenderingContext = FakeWebGL2;
    const calls: string[] = [];
    const gl = fakeGL();
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        calls.push(`${name}:${(args.at(-1) as { kind?: string })?.kind ?? ""}`);
    Object.assign(gl, { texImage2D: record("upload"), deleteTexture: (t: { kind?: string }) => calls.push(`delete:${t.kind}`) });
    const { renderer, context, extern, events } = phaser(gl);
    const image = { naturalWidth: 32, naturalHeight: 16 } as HTMLImageElement;
    const other = { naturalWidth: 8, naturalHeight: 8 } as HTMLImageElement;
    const phaserTex = { kind: "phaser" } as unknown as WebGLTexture;
    extern.scene = {
      sys: {
        textures: {
          getTextureKeys: () => ["hero"],
          get: () => ({ source: [{ image, glTexture: { webGLTexture: phaserTex, width: 32, height: 16, flipY: true, pma: true } }] }),
        },
      },
    };
    spryteExtern(extern, (draw) => {
      draw.sprite(image, 0, 0);
      draw.sprite(other, 0, 0);
    });
    extern.render(renderer, context, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    // Only `other`, which Phaser doesn't hold, is uploaded (after the 1x1 white texture spryte always makes).
    expect(calls.filter((c) => c.startsWith("upload")).length).toBe(2);
    events.get("destroy")?.();
    expect(calls).not.toContain("delete:phaser");
    expect(calls.filter((c) => c === "delete:Texture").length).toBe(2);
  });
});
