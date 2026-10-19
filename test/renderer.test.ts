import { describe, expect, it } from "vitest";
import { createRenderer } from "../src/index.js";

function canvasWith(contexts: Record<string, unknown>): HTMLCanvasElement {
  return { getContext: (type: string) => contexts[type] ?? null } as unknown as HTMLCanvasElement;
}

describe("createRenderer", () => {
  it("falls back to Canvas 2D, exposes the real context at once and resolves ready when loaded", async () => {
    const ctx = { setTransform() {}, fillRect() {} };
    const draw = createRenderer(canvasWith({ "2d": ctx }));
    expect(draw.kind).toBe("2d");
    expect(draw.raw).toEqual({ kind: "2d", ctx });
    draw.begin("#000", 10, 10, 1); // draws nothing yet, but doesn't throw
    draw.end();
    await draw.ready;
    expect(draw.raw).toEqual({ kind: "2d", ctx });
  });

  it("throws a clear error when WebGL2 is required but missing", () => {
    expect(() => createRenderer(canvasWith({ "2d": {} }), { backend: "webgl2" })).toThrow(/WebGL2 is unavailable/);
  });

  it("throws when the canvas has no usable context", () => {
    expect(() => createRenderer(canvasWith({}))).toThrow(/no WebGL2 or Canvas 2D context/);
  });
});
