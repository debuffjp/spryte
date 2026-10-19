import { describe, expect, it } from "vitest";
import { BitmapFont } from "../src/bitmap-font.js";
import { Canvas2DBackend } from "../src/canvas2d.js";
import { Draw, type Frame } from "../src/draw.js";

const image = { width: 30, height: 7 } as unknown as HTMLCanvasElement;
const grid = (n: number): Frame[] => Array.from({ length: n }, (_, i) => ({ image, x: i * 5, y: 0, w: 5, h: 7 }));

function recorder() {
  const calls: { name: string; args: unknown[] }[] = [];
  const ctx: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: "",
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: true,
  };
  for (const name of ["setTransform", "fillRect", "drawImage", "clearRect", "save", "restore", "beginPath", "rect", "clip"])
    ctx[name] = (...args: unknown[]) => calls.push({ name, args });
  return { draw: new Draw(new Canvas2DBackend(ctx as unknown as CanvasRenderingContext2D), false), calls };
}

describe("BitmapFont", () => {
  it("measures proportional glyphs with spacing and lines", () => {
    const font = new BitmapFont({ frames: grid(4), chars: "ab ?", widths: [3, 4, 0, 2] });
    expect(font.lineWidth("ab")).toBe(3 + 1 + 4);
    // Empty glyphs take the space width: round(7 / 3) = 2.
    expect(font.lineWidth("a b")).toBe(3 + 1 + 2 + 1 + 4);
    expect(font.measure("ab\na")).toEqual({ w: 8, h: 8 + 7 });
    expect(font.measure("")).toEqual({ w: 0, h: 0 });
    // Unknown characters fall back to "?".
    expect(font.lineWidth("z")).toBe(2);
  });

  it("supports monospaced widths and no fallback", () => {
    const font = new BitmapFont({ frames: grid(2), chars: "ab", widths: 5, spacing: 0, lineHeight: 10 });
    expect(font.measure("ab\nb")).toEqual({ w: 10, h: 17 });
    expect(font.lineWidth("zz")).toBe(0);
  });

  it("uses the frame width when pixels can't be read", () => {
    const font = new BitmapFont({ frames: grid(1), chars: "a" });
    expect(font.lineWidth("a")).toBe(5);
  });

  it("explains a grid that is too small", () => {
    expect(() => new BitmapFont({ frames: grid(1), chars: "ab" })).toThrow(/2 chars but only 1 frames/);
    expect(() => new BitmapFont({ frames: [], chars: "" })).toThrow(/at least one frame/);
  });

  it("has printable ASCII in order", () => {
    expect(BitmapFont.ASCII).toHaveLength(95);
    expect(BitmapFont.ASCII.startsWith(" !")).toBe(true);
    expect(BitmapFont.ASCII.endsWith("}~")).toBe(true);
  });
});

describe("Draw with a BitmapFont", () => {
  it("draws one quad per glyph on whole pixels, aligned", () => {
    const { draw, calls } = recorder();
    const font = new BitmapFont({ frames: grid(2), chars: "ab", widths: [3, 4] });
    draw.text("ab", 10.4, 5.6, { font });
    draw.text("ab", 20, 0, { font, align: "center", baseline: "bottom" });
    const quads = calls.filter((c) => c.name === "drawImage");
    expect(quads).toHaveLength(4);
    // drawImage(src, sx, sy, sw, sh, 0, 0, 1, 1) with a setTransform before it carrying the position.
    const at = calls.filter((c) => c.name === "setTransform").map((c) => [c.args[4], c.args[5]]);
    expect(at).toContainEqual([10, 6]);
    expect(at).toContainEqual([14, 6]);
    // Centred: width 8 → starts at 16; bottom: height 7 → top at -7.
    expect(at).toContainEqual([16, -7]);
    expect(draw.measure("ab", font)).toEqual({ w: 8, h: 7 });
  });

  it("uses draw.font when no font is given, resolving a function lazily", () => {
    const { draw, calls } = recorder();
    let built = 0;
    const font = new BitmapFont({ frames: grid(2), chars: "ab", widths: [3, 4] });
    draw.font = () => {
      built++;
      return font;
    };
    expect(built).toBe(0);
    expect(draw.measure("ab")).toEqual({ w: 8, h: 7 });
    draw.text("ab", 0, 0);
    expect(calls.filter((c) => c.name === "drawImage")).toHaveLength(2);
  });
});
