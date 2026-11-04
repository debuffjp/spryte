import { afterEach, describe, expect, it, vi } from "vitest";
import { Canvas2DBackend } from "../src/canvas2d.js";
import { Draw } from "../src/draw.js";
import { canDrawElements, drawElement } from "../src/element.js";
import type { RenderTarget } from "../src/target.js";

function setup() {
  const canvas = document.createElement("canvas");
  const calls: { name: string; args: unknown[]; alpha: number }[] = [];
  const ctx: Record<string, unknown> = { canvas, globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "" };
  for (const name of ["setTransform", "fillRect", "drawImage", "clearRect", "drawElementImage"])
    ctx[name] = (...args: unknown[]) => calls.push({ name, args, alpha: ctx.globalAlpha as number });
  const draw = new Draw(new Canvas2DBackend(ctx as unknown as CanvasRenderingContext2D), false);
  const el = document.createElement("form");
  document.body.append(el);
  return { canvas, calls, draw, el };
}

const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
afterEach(() => {
  delete proto.updateElementGeometry;
  vi.restoreAllMocks();
});

describe("drawElement", () => {
  it("draws nothing and leaves the element alone without HTML-in-Canvas", () => {
    const { draw, el } = setup();
    expect(canDrawElements()).toBe(false);
    draw.begin(0x000000ff, 100, 50, 1);
    expect(drawElement(draw, el, 10, 10)).toBe(false);
    expect(el.parentElement).toBe(document.body);
  });

  it("moves the element into the canvas, then draws it through the current transform", () => {
    proto.updateElementGeometry = () => {};
    const { canvas, calls, draw, el } = setup();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    draw.begin(0x000000ff, 100, 50, 2);
    expect(drawElement(draw, el, 10, 5)).toBe(false);
    expect(el.parentElement).toBe(canvas);
    expect(canvas.getAttribute("content")).toBe("drawable");
    expect(el.hasAttribute("drawable")).toBe(true);

    calls.length = 0;
    draw.alpha = 0.5;
    expect(drawElement(draw, el, 10, 5, { alpha: 0.5 })).toBe(true);
    // The unit square maps to the 40x20 logical box at (10, 5), at 2 backing pixels per unit.
    expect(calls.map((c) => c.name)).toEqual(["setTransform", "drawElementImage"]);
    expect(calls[0]?.args).toEqual([80, 0, 0, 40, 20, 10]);
    expect(calls[1]?.args).toEqual([el, 0, 0, 1, 1]);
    expect(calls[1]?.alpha).toBe(0.25);
  });

  it("returns false, without throwing, until the browser has painted the element", () => {
    proto.updateElementGeometry = () => {};
    const { canvas, draw, el } = setup();
    canvas.append(el);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(40);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20);
    // What Chrome 157 throws on the first frame after the element moves into the canvas.
    (draw.raw as { ctx: Record<string, unknown> }).ctx.drawElementImage = () => {
      throw new DOMException("No cached paint record for element.", "InvalidStateError");
    };
    draw.begin(0x000000ff, 100, 50, 1);
    expect(drawElement(draw, el, 0, 0)).toBe(false);
  });

  it("refuses to draw into a render target", () => {
    proto.updateElementGeometry = () => {};
    const { draw, el } = setup();
    draw.begin(0x000000ff, 100, 50, 1);
    // What into() sets while it runs; a real target needs a canvas that happy-dom can't draw into.
    draw.target = {} as RenderTarget;
    expect(drawElement(draw, el, 0, 0)).toBe(false);
    expect(el.parentElement).toBe(document.body);
  });
});
