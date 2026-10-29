import { describe, expect, it } from "vitest";
import type { Backend, Matrix } from "../src/backend.js";
import { Draw } from "../src/draw.js";

/** A Draw over a backend that records each quad's matrix. */
function recorder() {
  const quads: Matrix[] = [];
  const noop = () => {};
  const backend = {
    kind: "2d",
    raw: { kind: "2d", ctx: {} },
    begin: noop,
    quad: (m: Matrix) => quads.push([...m] as Matrix),
    path: noop,
    setBlend: noop,
    setClip: noop,
    setTarget: noop,
    setShader: noop,
    disposeTarget: noop,
    end: noop,
    resize: noop,
    invalidate: noop,
    dispose: noop,
  } as unknown as Backend;
  const draw = new Draw(backend, false);
  draw.begin("#000", 100, 100, 1);
  return { draw, quads };
}

const unit = (draw: Draw) => draw.rect(0, 0, 1, 1, "#fff");

describe("draw.transform", () => {
  it("does what the equivalent translate, rotate and scale do, bit for bit", () => {
    const a = recorder();
    a.draw.translate(20, 10);
    a.draw.rotate(0.5);
    a.draw.scale(1.5, 0.75);
    unit(a.draw);
    const b = recorder();
    b.draw.transform(1, 0, 0, 1, 20, 10);
    b.draw.transform(Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 0, 0);
    b.draw.transform(1.5, 0, 0, 0.75, 0, 0);
    unit(b.draw);
    expect(b.quads[0]).toEqual(a.quads[0]);
  });

  it("composes skew, which translate, rotate and scale can't express", () => {
    const { draw, quads } = recorder();
    draw.scale(2, 1);
    draw.transform(0.6, 0.8, -0.8, 0.6, 5, 7); // a rotation, in a basis stretched 2× along x
    unit(draw);
    const [a, b, c, d, e, f] = quads[0] as Matrix;
    expect([a, b, c, d, e, f]).toEqual([2 * 0.6, 0.8, 2 * -0.8, 0.6, 2 * 5, 7]);
    // Later moves happen in the new basis.
    draw.translate(1, 0);
    unit(draw);
    expect(quads[1]?.slice(4)).toEqual([2 * 5 + 2 * 0.6, 7 + 0.8]);
  });

  it("is undone by pop()", () => {
    const { draw, quads } = recorder();
    draw.push();
    draw.transform(1, 2, 3, 4, 5, 6);
    draw.pop();
    unit(draw);
    expect(quads[0]).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("draw.begin(null)", () => {
  it("passes a null clear to the backend", () => {
    const clears: (number | null)[] = [];
    const backend = { ...(recorder().draw.backend as object), begin: (clear: number | null) => clears.push(clear) } as Backend;
    const draw = new Draw(backend, false);
    draw.begin(null, 10, 10, 1);
    draw.begin("#f00", 10, 10, 1);
    expect(clears).toEqual([null, 0xff0000ff]);
  });
});
