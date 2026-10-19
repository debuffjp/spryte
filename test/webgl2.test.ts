import { describe, expect, it } from "vitest";
import type { Matrix, TextureSource } from "../src/backend.js";
import { WebGL2Backend } from "../src/webgl2.js";

/**
 * A recording stand-in for WebGL2: every method is logged, `create*` returns a fresh tagged object and
 * `delete*` marks it deleted, so tests can check uploads, batching and that nothing leaks.
 */
function fakeGL() {
  const calls: { name: string; args: unknown[] }[] = [];
  const created: { kind: string; deleted: boolean }[] = [];
  const listeners = new Map<string, (e: Event) => void>();
  const canvas = {
    addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const shaderSources: string[] = [];
  const target: Record<string | symbol, unknown> = {
    canvas,
    drawingBufferWidth: 100,
    drawingBufferHeight: 50,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: () => ({}),
    shaderSource: (_s: unknown, src: string) => shaderSources.push(src),
  };
  const gl = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string") return undefined;
      if (/^[A-Z0-9_]+$/.test(key)) return key; // constants: their own name, readable in assertions
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        if (key.startsWith("create")) {
          const obj = { kind: key.slice(6), deleted: false };
          created.push(obj);
          return obj;
        }
        if (key.startsWith("delete")) (args[0] as { deleted: boolean }).deleted = true;
        return undefined;
      };
    },
  });
  const fire = (type: string) => listeners.get(type)?.({ preventDefault() {} } as Event);
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  return { gl: gl as unknown as WebGL2RenderingContext, calls, created, fire, count, shaderSources, listeners };
}

const M: Matrix = [16, 0, 0, 16, 0, 0];
const image = (w = 16, h = 16) => ({ width: w, height: h }) as unknown as TextureSource;

describe("WebGL2Backend", () => {
  it("uses highp texture coordinates so large atlases sample the right texel on mobile GPUs", () => {
    const { gl, shaderSources } = fakeGL();
    new WebGL2Backend(gl);
    expect(shaderSources[1]).toContain("in highp vec2 v_uv");
  });

  it("uploads a source once even when drawn both smooth and pixelated", () => {
    const { gl, count, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    const uploadsBefore = count("texImage2D");
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, true);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("texImage2D") - uploadsBefore).toBe(1);
    // One batch, two units: same texture, different samplers.
    expect(count("drawArraysInstanced")).toBe(1);
    const samplers = calls.filter((c) => c.name === "bindSampler").map((c) => c.args[0]);
    expect(samplers).toEqual([0, 1]);
  });

  it("splits batches when more than 8 textures are in flight, and counts draw calls", () => {
    const { gl, count } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.begin(0x000000ff, 100, 50, 1);
    for (let i = 0; i < 9; i++) be.quad(M, image(), 0, 0, 16, 16, 0xffffffff, 0, false);
    expect(be.drawCalls).toBe(2);
    be.end();
    expect(count("drawArraysInstanced")).toBe(2);
  });

  it("skips drawing while the context is lost and re-uploads after restore", () => {
    const { gl, count, fire } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    fire("webglcontextlost");
    expect(be.contextLost).toBe(true);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("drawArraysInstanced")).toBe(1);
    const uploads = count("texImage2D");
    fire("webglcontextrestored");
    expect(be.contextLost).toBe(false);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    // Restore recreates the white texture and re-uploads the source on first use.
    expect(count("texImage2D") - uploads).toBe(2);
    expect(count("drawArraysInstanced")).toBe(2);
  });

  it("dispose() deletes every GPU object it created and removes its listeners", () => {
    const { gl, created, listeners } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, image(), 0, 0, 16, 16, 0xffffffff, 0, true);
    be.end();
    be.dispose();
    expect(created.filter((o) => !o.deleted).map((o) => o.kind)).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it("invalidate() re-uploads changed pixels", () => {
    const { gl, count } = fakeGL();
    const be = new WebGL2Backend(gl);
    const img = image();
    be.begin(0x000000ff, 100, 50, 1);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.invalidate(img);
    be.quad(M, img, 0, 0, 16, 16, 0xffffffff, 0, false);
    be.end();
    expect(count("texImage2D")).toBe(3); // white + two uploads
  });

  it("scissors in bottom-left coordinates", () => {
    const { gl, calls } = fakeGL();
    const be = new WebGL2Backend(gl);
    be.setClip({ x: 10, y: 5, w: 20, h: 10 });
    expect(calls.find((c) => c.name === "scissor")?.args).toEqual([10, 35, 20, 10]);
  });
});
