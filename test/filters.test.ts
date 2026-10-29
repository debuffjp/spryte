import { describe, expect, it } from "vitest";
import { blur, colorMatrix, grayscale, hueRotate, invert } from "../src/filters.js";

describe("filters", () => {
  it("blur is two passes in device pixels, and nothing at radius 0", () => {
    const f = blur(3);
    expect(f.passes).toHaveLength(2);
    expect(f.passes[0]?.shader).toBe(blur(1).passes[0]?.shader); // shared, never recompiled
    expect(f.passes[1]?.smooth).toBe(true);
    expect(f.passes[1]?.uniforms(0.01, 0.02, 2)).toEqual([
      ["dir", [0, 0.02]],
      ["sigma", 6],
    ]);
    expect(f.css(2)).toBe("blur(6px)");
    expect(blur(0).passes).toHaveLength(0);
  });

  it("named colour filters have CSS equivalents; raw matrices don't", () => {
    expect(grayscale().css(1)).toBe("grayscale(1)");
    expect(hueRotate(1).css(1)).toBe("hue-rotate(1rad)");
    expect(colorMatrix(new Array(20).fill(0)).css(1)).toBeNull();
    expect(() => colorMatrix([1, 2, 3])).toThrow(/20 numbers/);
  });

  it("invert maps 0 to 1 through the offset row", () => {
    const u = Object.fromEntries(invert().passes[0]?.uniforms(1, 1, 1) ?? []);
    expect(u.r).toEqual([-1, 0, 0, 0]);
    expect(u.o).toEqual([1, 1, 1, 0]);
  });
});
