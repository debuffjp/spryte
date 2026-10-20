import { describe, expect, it } from "vitest";
import { Canvas2DBackend } from "../src/canvas2d.js";
import { Draw } from "../src/draw.js";

function recordingContext() {
  const calls: { name: string; args: unknown[]; state: { alpha: number; fill: unknown; op: string } }[] = [];
  const ctx: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "",
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
  };
  for (const name of ["setTransform", "fillRect", "drawImage", "clearRect", "save", "restore", "beginPath", "rect", "clip"]) {
    ctx[name] = (...args: unknown[]) =>
      calls.push({
        name,
        args,
        state: { alpha: ctx.globalAlpha as number, fill: ctx.fillStyle, op: ctx.globalCompositeOperation as string },
      });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
}

describe("Canvas2DBackend", () => {
  it("clears with the background and scales logical units to the backing store", () => {
    const { ctx, calls } = recordingContext();
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    draw.begin("#11140d", 320, 180, 2);
    expect(calls[0]).toMatchObject({ name: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    expect(calls[1]).toMatchObject({ name: "fillRect", args: [0, 0, 320, 180], state: { fill: "rgba(17,20,13,1)" } });
  });

  it("draws rects as transformed unit squares with their colour", () => {
    const { ctx, calls } = recordingContext();
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    draw.begin("#000", 100, 100, 1);
    calls.length = 0;
    draw.rect(10, 20, 30, 40, "#cffb2d80");
    expect(calls[0]).toMatchObject({ name: "setTransform", args: [30, 0, 0, 40, 10, 20] });
    expect(calls[1]?.name).toBe("fillRect");
    expect(String(calls[1]?.state.fill)).toMatch(/^rgba\(207,251,45,0\.50/);
  });

  it("draws images from their source rect with alpha, smoothing and additive blending", () => {
    const { ctx, calls, raw } = recordingContext();
    const draw = new Draw(new Canvas2DBackend(ctx), true);
    draw.begin("#000", 100, 100, 1);
    calls.length = 0;
    const image = { width: 32, height: 32 } as unknown as HTMLImageElement;
    draw.blend("add");
    draw.sprite({ image, x: 8, y: 0, w: 8, h: 8 }, 50, 50, { alpha: 0.5, smooth: false });
    const img = calls.find((c) => c.name === "drawImage");
    expect(img?.args.slice(1)).toEqual([8, 0, 8, 8, 0, 0, 1, 1]);
    expect(img?.state.alpha).toBeCloseTo(0.5, 2);
    expect(img?.state.op).toBe("lighter");
    expect(raw.imageSmoothingEnabled).toBe(false);
  });
});

describe("Canvas2DBackend clip", () => {
  it("clips with save/rect/clip and restores before changing", () => {
    const { ctx, calls } = recordingContext();
    const backend = new Canvas2DBackend(ctx);
    backend.setClip({ x: 1, y: 2, w: 3, h: 4 });
    backend.setClip(null);
    expect(calls.map((c) => c.name)).toEqual(["save", "setTransform", "beginPath", "rect", "clip", "restore"]);
    expect(calls.find((c) => c.name === "rect")?.args).toEqual([1, 2, 3, 4]);
  });
});

describe("Draw.measure", () => {
  // Non-empty text needs a real 2D canvas; the platformer's pause scenario measures it in a browser.
  it("is empty for empty text", () => {
    const { ctx } = recordingContext();
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    expect(draw.measure("")).toEqual({ w: 0, h: 0 });
  });
});

describe("Canvas2DBackend tint", () => {
  it("draws untinted textures directly and tinted ones through a recoloured copy", () => {
    const { ctx, calls } = recordingContext();
    const backend = new Canvas2DBackend(ctx);
    const src = { width: 4, height: 4 } as unknown as HTMLCanvasElement;
    const m = [1, 0, 0, 1, 0, 0] as unknown as Parameters<Canvas2DBackend["quad"]>[0];
    backend.quad(m, src, 0, 0, 4, 4, 0xffffffff, 0, false);
    backend.quad(m, src, 0, 0, 4, 4, 0xcffb2dff, 0, false);
    const draws = calls.filter((c) => c.name === "drawImage");
    expect(draws[0]?.args[0]).toBe(src);
    expect(draws[1]?.args[0]).not.toBe(src);
  });
});
