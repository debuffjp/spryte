// Adversarial QA: each test documents a real bug and FAILS on the current source.
import { describe, expect, it } from "vitest";
import type { TextureSource } from "../src/backend.js";
import { Canvas2DBackend } from "../src/canvas2d.js";
import { Draw } from "../src/draw.js";
import { WebGL2Backend } from "../src/webgl2.js";

function fakeGL(opts: { compileOk?: (src: string) => boolean } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const created: { kind: string; deleted: boolean }[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const sources = new Map<unknown, string>();
  const canvas = {
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const target: Record<string | symbol, unknown> = {
    canvas,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: (s: unknown) => (opts.compileOk ? opts.compileOk(sources.get(s) ?? "") : true),
    getShaderInfoLog: () => "ERROR: 0:3: 'nope' : no matching overloaded function found",
    getProgramParameter: () => true,
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: (p: unknown) => (p === "MAX_TEXTURE_SIZE" ? 16384 : undefined),
    getUniformLocation: () => ({}),
    shaderSource: (s: unknown, src: string) => sources.set(s, src),
  };
  const gl = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key;
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (key.startsWith("create")) {
          const obj = { kind: key.slice(6), deleted: false };
          created.push(obj);
          return obj;
        }
        if (key.startsWith("delete") && args[0]) (args[0] as { deleted: boolean }).deleted = true;
        return undefined;
      };
    },
  });
  return { gl: gl as unknown as WebGL2RenderingContext, calls, created, listeners };
}
const image = (w = 16, h = 16) => ({ width: w, height: h }) as unknown as TextureSource;
const failNope = (src: string) => !src.includes("nope");

describe("adversarial: custom shader compile failure", () => {
  it("a shader that failed to compile does not poison the renderer (later draws and end() must not throw)", () => {
    const { gl } = fakeGL({ compileOk: failNope });
    const draw = new Draw(new WebGL2Backend(gl), false);
    const bad = draw.createShader("uniform float t; vec4 effect(vec4 color, vec2 uv) { return nope(uv); }");
    bad.set("t", 1);
    draw.begin("#000", 100, 50, 1);
    expect(() => draw.withShader(bad, () => draw.rect(0, 0, 1, 1, "#fff"))).toThrow(/compile/);
    // The game caught the error and carries on drawing without the effect.
    draw.rect(0, 0, 10, 10, "#f00");
    expect(() => draw.end()).not.toThrow();
  });

  it("retrying a shader that failed to compile throws again instead of silently drawing without it", () => {
    const { gl } = fakeGL({ compileOk: failNope });
    const draw = new Draw(new WebGL2Backend(gl), false);
    const bad = draw.createShader("vec4 effect(vec4 color, vec2 uv) { return nope(uv); }");
    draw.begin("#000", 100, 50, 1);
    expect(() => draw.withShader(bad, () => {})).toThrow();
    draw.end();
    draw.begin("#000", 100, 50, 1);
    expect(() => draw.withShader(bad, () => {})).toThrow();
  });

  it("a failed withShader restores Draw's own shader state", () => {
    const { gl } = fakeGL({ compileOk: failNope });
    const draw = new Draw(new WebGL2Backend(gl), false);
    const bad = draw.createShader("vec4 effect(vec4 color, vec2 uv) { return nope(uv); }");
    draw.begin("#000", 100, 50, 1);
    try {
      draw.withShader(bad, () => {});
    } catch {}
    expect((draw as unknown as { shader: unknown }).shader).toBe(null);
  });
});

describe("adversarial: hostile sprites() counts", () => {
  it("count larger than positions.length / 2 is clamped (no out-of-range bufferData)", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    const pos = new Float32Array([1, 2, 3, 4]); // 2 copies
    draw.sprites(image(), pos, 10);
    draw.end();
    const upload = calls.filter((c) => c.name === "bufferData" && c.args[1] === pos).at(-1);
    // Real GL raises INVALID_VALUE here and the whole sprites() call draws nothing.
    expect(upload?.args[4]).toBeLessThanOrEqual(pos.length);
    expect(draw.quads).toBe(2);
  });

  it("count larger than positions.length / 2 with a plain array does not feed NaN positions", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(image(), [1, 2], 3);
    draw.end();
    const upload = calls.filter((c) => c.name === "bufferData" && c.args[1] instanceof Float32Array && c.args[2] === "STREAM_DRAW").at(-1);
    if (!upload) throw new Error("no position upload");
    const data = Array.from((upload.args[1] as Float32Array).subarray(0, upload.args[4] as number));
    expect(data.some(Number.isNaN)).toBe(false);
  });

  it("a NaN count is rejected and doesn't turn draw.quads into NaN", () => {
    const { gl } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(image(), new Float32Array(4), Number.NaN);
    draw.rect(0, 0, 1, 1, "#fff");
    expect(draw.quads).toBe(1);
  });

  it("an each.color array shorter than count is not over-read", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    const color = new Uint32Array([0xff0000ff]);
    draw.sprites(image(), new Float32Array(8), 4, {}, { color });
    draw.end();
    const upload = calls.find((c) => c.name === "bufferData" && c.args[1] === color);
    expect(upload?.args[4]).toBeLessThanOrEqual(color.length);
  });
});

describe("adversarial: lifecycle", () => {
  it("drawing after dispose() throws instead of silently re-creating GPU objects on a dead renderer", () => {
    const { gl, created } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.dispose();
    const before = created.length;
    let threw = false;
    try {
      draw.begin("#000", 100, 50, 1);
      draw.sprite(image(), 0, 0);
      draw.end();
    } catch {
      threw = true;
    }
    expect(threw || created.length === before).toBe(true);
  });
});

describe("adversarial: Canvas 2D smoothing cache vs clip save/restore", () => {
  it("a smooth sprite drawn after a clip that drew smooth sprites is still smoothed", () => {
    // Minimal context with real save/restore semantics for the state the backend caches.
    const state = { imageSmoothingEnabled: true, globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "" };
    const stack: (typeof state)[] = [];
    const smoothAtDraw: boolean[] = [];
    const ctx = Object.assign(state, {
      save: () => stack.push({ ...state }),
      restore: () => Object.assign(state, stack.pop()),
      setTransform() {},
      fillRect() {},
      clearRect() {},
      beginPath() {},
      rect() {},
      clip() {},
      drawImage: () => smoothAtDraw.push(state.imageSmoothingEnabled),
    }) as unknown as CanvasRenderingContext2D;
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    const img = image();
    draw.begin("#000", 100, 100, 1);
    draw.sprite(img, 10, 10); // pixel art: smoothing off
    draw.clip(0, 0, 50, 50, () => draw.sprite(img, 10, 10, { smooth: true }));
    draw.sprite(img, 10, 10, { smooth: true });
    draw.end();
    expect(smoothAtDraw).toEqual([false, true, true]);
  });
});
