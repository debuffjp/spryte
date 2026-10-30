import { afterEach, describe, expect, it, vi } from "vitest";
import { Canvas2DBackend } from "../src/canvas2d.js";
import { Draw } from "../src/draw.js";
import { mask } from "../src/mask.js";

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

describe("Canvas2DBackend blend modes", () => {
  it("maps each mode to its composite operation", () => {
    const { ctx, raw } = recordingContext();
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    const ops: string[] = [];
    for (const mode of ["multiply", "screen", "erase", "normal"] as const) {
      draw.blend(mode);
      ops.push(raw.globalCompositeOperation as string);
    }
    expect(ops).toEqual(["multiply", "screen", "destination-out", "source-over"]);
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

describe("Canvas2DBackend offscreen passes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a mask inside a clip leaves the screen's save/restore balanced", () => {
    const { ctx, calls } = recordingContext();
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {}
        getContext() {
          return recordingContext().ctx;
        }
      },
    );
    const draw = new Draw(new Canvas2DBackend(ctx), false);
    draw.resize(100, 100);
    draw.begin("#000", 100, 100, 1);
    draw.clip(0, 0, 50, 50, () =>
      mask(
        draw,
        () => draw.rect(0, 0, 10, 10, "#fff"),
        () => draw.rect(0, 0, 50, 50, "#f00"),
      ),
    );
    draw.end();
    const saves = calls.filter((c) => c.name === "save").length;
    const restores = calls.filter((c) => c.name === "restore").length;
    expect(restores).toBe(saves);
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

  // happy-dom canvases have no 2D context, so recoloured copies would never be cached: give them a minimal one.
  const offscreen = () => {
    const fake = () =>
      ({
        drawImage() {},
        putImageData() {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(fake);
    // Recoloured copies are OffscreenCanvases where the environment has them.
    if (typeof OffscreenCanvas !== "undefined") vi.spyOn(OffscreenCanvas.prototype, "getContext").mockImplementation(fake as never);
  };
  afterEach(() => vi.restoreAllMocks());

  it("keeps more than 256 tints cached, so a second frame reuses every recoloured copy", () => {
    offscreen();
    const { ctx, calls } = recordingContext();
    const backend = new Canvas2DBackend(ctx);
    const src = { width: 4, height: 4 } as unknown as HTMLCanvasElement;
    const m = [1, 0, 0, 1, 0, 0] as unknown as Parameters<Canvas2DBackend["quad"]>[0];
    const frame = () => {
      for (let i = 0; i < 300; i++) backend.quad(m, src, 0, 0, 4, 4, ((i * 0x010203) << 8) | 0xff, 0, false);
      return calls
        .splice(0)
        .filter((c) => c.name === "drawImage")
        .map((c) => c.args[0]);
    };
    const first = frame();
    const second = frame();
    // Before 0.8 the cache cleared at 256 entries, so these were all fresh copies again.
    expect(second.every((s, i) => s === first[i])).toBe(true);
  });

  it("invalidate() drops a remembered recoloured copy", () => {
    offscreen();
    const { ctx, calls } = recordingContext();
    const backend = new Canvas2DBackend(ctx);
    const src = { width: 4, height: 4 } as unknown as HTMLCanvasElement;
    const m = [1, 0, 0, 1, 0, 0] as unknown as Parameters<Canvas2DBackend["quad"]>[0];
    backend.quad(m, src, 0, 0, 4, 4, 0xcffb2dff, 0, false);
    backend.invalidate(src);
    backend.quad(m, src, 0, 0, 4, 4, 0xcffb2dff, 0, false);
    const [a, b] = calls.filter((c) => c.name === "drawImage").map((c) => c.args[0]);
    expect(b).not.toBe(a);
  });
});
