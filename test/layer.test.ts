import { describe, expect, it } from "vitest";
import type { Backend, Matrix, TextureSource } from "../src/backend.js";
import { Draw, type Frame } from "../src/draw.js";
import type { Layer } from "../src/layer.js";

/** A backend that records quads, with an optional `replay` that records what it was asked to draw. */
function setup(withReplay = false) {
  const quads: { m: Matrix; src: TextureSource | null; color: number }[] = [];
  const replays: { layer: Layer; m: Matrix }[] = [];
  const backend: Backend = {
    kind: "2d",
    raw: { kind: "2d", ctx: {} as CanvasRenderingContext2D },
    begin: () => {},
    quad: (m, src, _sx, _sy, _sw, _sh, color) => quads.push({ m: [...m] as Matrix, src, color }),
    quads: () => {},
    copies: () => {},
    path: () => {},
    mesh: () => {},
    setBlend: () => {},
    setClip: () => {},
    setTarget: () => {},
    setShader: () => {},
    disposeTarget: () => {},
    end: () => {},
    resize: () => {},
    invalidate: () => {},
    dispose: () => {},
    ...(withReplay
      ? {
          replay: (layer: Layer, m: Matrix) => {
            replays.push({ layer, m: [...m] as Matrix });
            return true;
          },
        }
      : {}),
  };
  const draw = new Draw(backend, false);
  draw.begin("#000", 100, 100, 1);
  return { draw, quads, replays };
}

const image = { width: 16, height: 16 } as unknown as TextureSource;
const frame: Frame = { image, x: 0, y: 0, w: 8, h: 8 };
const content = (d: Draw) => {
  d.sprite(frame, 3, 4, { origin: [0, 0] });
  d.sprite(frame, 10.5, 2, { tint: "#88f", alpha: 0.5 });
  d.push();
  d.translate(20, 30);
  d.sprite(frame, 1, 1, { rotation: 0.3 });
  d.pop();
};

describe("record and replay", () => {
  it("record draws nothing and keeps every sprite", () => {
    const { draw, quads } = setup();
    const layer = draw.record(content);
    expect(quads).toHaveLength(0);
    expect(layer.size).toBe(3);
  });

  it("without a backend replay, draws exactly what drawing the sprites there would", () => {
    const direct = setup();
    direct.draw.translate(5.5, -2);
    content(direct.draw);
    const replayed = setup();
    const layer = replayed.draw.record(content);
    replayed.draw.translate(5.5, -2);
    replayed.draw.replay(layer);
    expect(replayed.quads).toEqual(direct.quads);
  });

  it("hands the layer to the backend under the current transform, and counts its sprites", () => {
    const { draw, replays } = setup(true);
    const layer = draw.record(content);
    draw.translate(7, 8);
    const before = draw.quads;
    draw.replay(layer);
    expect(replays).toEqual([{ layer, m: [1, 0, 0, 1, 7, 8] }]);
    expect(draw.quads - before).toBe(3);
  });

  it("applies draw.alpha at replay, not at record: under alpha the sprites are drawn one by one", () => {
    const { draw, quads, replays } = setup(true);
    draw.alpha = 0.25;
    const layer = draw.record(content);
    draw.alpha = 1;
    expect(layer.items.map((i) => i.color & 0xff)).toEqual([255, 128, 255]);
    draw.alpha = 0.5;
    draw.replay(layer);
    expect(replays).toHaveLength(0);
    expect(quads.map((q) => q.color & 0xff)).toEqual([128, 64, 128]);
  });

  it("restores the transform, alpha and backend after record, even when it throws", () => {
    const { draw, quads } = setup();
    draw.translate(3, 4);
    draw.alpha = 0.5;
    expect(() =>
      draw.record((d) => {
        d.push();
        d.translate(9, 9);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(draw.m).toEqual([1, 0, 0, 1, 3, 4]);
    expect(draw.alpha).toBe(0.5);
    draw.sprite(frame, 0, 0);
    expect(quads).toHaveLength(1);
    // The push inside fn and record()'s own were both unwound: the stack is as it was.
    expect(() => draw.pop()).toThrow(/without a matching push/);
  });

  it("only draw.sprite can be recorded, and records don't nest", () => {
    const { draw } = setup();
    expect(() => draw.record((d) => d.rect(0, 0, 4, 4, "#fff"))).toThrow(/only draw.sprite can be recorded/);
    expect(() => draw.record((d) => d.record(() => {}))).toThrow(/inside another record/);
    const layer = draw.record(content);
    expect(() => draw.record((d) => d.replay(layer))).toThrow(/can't be recorded/);
  });

  it("an empty layer replays as nothing", () => {
    const { draw, quads, replays } = setup(true);
    draw.replay(draw.record(() => {}));
    expect(quads).toHaveLength(0);
    expect(replays).toHaveLength(0);
  });
});
