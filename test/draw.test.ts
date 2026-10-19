import { describe, expect, it } from "vitest";
import type { Backend, ClipRect, Matrix, TextureSource } from "../src/backend.js";
import { Draw } from "../src/draw.js";
import { toRGBA } from "../src/index.js";

interface Quad {
  m: Matrix;
  src: TextureSource | null;
  uv: readonly number[];
  color: number;
  flash: number;
  smooth: boolean;
}

function recorder() {
  const quads: Quad[] = [];
  const blends: string[] = [];
  const clips: (ClipRect | null)[] = [];
  const backend: Backend = {
    kind: "2d",
    raw: { kind: "2d", ctx: {} as CanvasRenderingContext2D },
    begin: () => {},
    quad: (m, src, sx, sy, sw, sh, color, flash, smooth) =>
      quads.push({ m: [...m] as Matrix, src, uv: [sx, sy, sw, sh], color, flash, smooth }),
    setBlend: (mode) => blends.push(mode),
    setClip: (rect) => clips.push(rect),
    end: () => {},
    resize: () => {},
    invalidate: () => {},
    dispose: () => {},
  };
  const draw = new Draw(backend, false);
  draw.begin("#000", 100, 100, 1);
  const quad = (i: number): Quad => {
    const q = quads[i];
    if (!q) throw new Error(`no quad ${i}`);
    return q;
  };
  return { draw, quads, quad, blends, clips };
}

/** Where the unit square's corner (u, v) lands. */
const at = (m: Matrix, u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

describe("toRGBA", () => {
  it("parses hex forms and passes numbers through", () => {
    expect(toRGBA("#cffb2d")).toBe(0xcffb2dff);
    expect(toRGBA("#fff")).toBe(0xffffffff);
    expect(toRGBA("#11223344")).toBe(0x11223344);
    expect(toRGBA(0x01020304)).toBe(0x01020304);
  });
});

describe("Draw", () => {
  it("puts unrotated pixel-art sprites on whole pixels, but not smooth or rotated ones", () => {
    const { draw, quad } = recorder();
    const frame = { image: {} as TextureSource, x: 0, y: 0, w: 8, h: 8 };
    draw.sprite(frame, 10.4, 20.6);
    draw.sprite(frame, 10.4, 20.6, { smooth: true });
    draw.sprite(frame, 10.4, 20.6, { rotation: 0.5 });
    expect(at(quad(0).m, 0, 0)).toEqual([6, 17]);
    expect(at(quad(1).m, 0, 0)[0]).toBeCloseTo(6.4);
    expect(Number.isInteger(at(quad(2).m, 0, 0)[0])).toBe(false);
  });

  it("maps rects onto the unit square", () => {
    const { draw, quad } = recorder();
    draw.rect(10, 20, 30, 40, "#ff0000");
    expect(at(quad(0).m, 0, 0)).toEqual([10, 20]);
    expect(at(quad(0).m, 1, 1)).toEqual([40, 60]);
    expect(quad(0).src).toBeNull();
    expect(quad(0).color).toBe(0xff0000ff);
  });

  it("composes push/translate/scale/pop and throws on unbalanced pop", () => {
    const { draw, quad } = recorder();
    draw.push();
    draw.translate(50, 50);
    draw.scale(2);
    draw.rect(0, 0, 1, 1, "#fff");
    draw.pop();
    draw.rect(0, 0, 1, 1, "#fff");
    expect(at(quad(0).m, 1, 1)).toEqual([52, 52]);
    expect(at(quad(1).m, 1, 1)).toEqual([1, 1]);
    expect(() => draw.pop()).toThrow(/without a matching push/);
  });

  it("anchors, flips and rotates sprites, passing source rect, flash and filtering", () => {
    const { draw, quad } = recorder();
    const image = { width: 64, height: 64 } as unknown as TextureSource;
    draw.sprite({ image, x: 16, y: 0, w: 16, h: 8 }, 100, 100, { origin: [0.5, 1], flipX: true, flash: 0.5 });
    const q = quad(0);
    expect(q.uv).toEqual([16, 0, 16, 8]);
    expect(at(q.m, 0, 0)).toEqual([108, 92]); // flipped: left edge maps to the right
    expect(at(q.m, 1, 1)).toEqual([92, 100]);
    expect(q.flash).toBe(0.5);
    expect(q.smooth).toBe(false);
    draw.sprite({ image, x: 0, y: 0, w: 10, h: 10 }, 0, 0, { rotation: Math.PI / 2 });
    const [x, y] = at(quad(1).m, 0, 0);
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(-5);
  });

  it("multiplies global and per-draw alpha into the colour", () => {
    const { draw, quad } = recorder();
    draw.alpha = 0.5;
    draw.sprite({ image: {} as TextureSource, x: 0, y: 0, w: 1, h: 1 }, 0, 0, { alpha: 0.5 });
    expect(quad(0).color & 0xff).toBe(64);
  });

  it("applies the camera view and restores afterwards", () => {
    const { draw, quad } = recorder();
    // What a centred 100x100 camera at (200, 50) returns.
    const camera = { view: (): Matrix => [1, 0, 0, 1, 50 - 200, 50 - 50] };
    draw.withCamera(camera, () => draw.rect(200, 50, 1, 1, "#fff"));
    draw.rect(0, 0, 1, 1, "#fff");
    expect(at(quad(0).m, 0, 0)).toEqual([50, 50]);
    expect(at(quad(1).m, 0, 0)).toEqual([0, 0]);
  });

  it("draws lines as rotated rects and forwards blend modes", () => {
    const { draw, quad, blends } = recorder();
    draw.blend("add");
    draw.line(0, 0, 0, 10, 2, "#fff");
    const [x, y] = at(quad(0).m, 1, 0.5);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(10);
    expect(blends.at(-1)).toBe("add");
  });
});

describe("Draw.clip", () => {
  it("clips in backing pixels, intersects nested clips and restores", () => {
    const { draw, clips } = recorder();
    draw.renderScale = 2;
    draw.translate(10, 0);
    draw.clip(0, 0, 50, 40, () => {
      draw.clip(30, 20, 100, 100, () => {});
    });
    expect(clips).toEqual([{ x: 20, y: 0, w: 100, h: 80 }, { x: 80, y: 40, w: 40, h: 40 }, { x: 20, y: 0, w: 100, h: 80 }, null]);
  });

  it("restores the clip even if the callback throws", () => {
    const { draw, clips } = recorder();
    expect(() =>
      draw.clip(0, 0, 10, 10, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(clips.at(-1)).toBeNull();
  });
});
