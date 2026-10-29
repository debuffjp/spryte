import { describe, expect, it } from "vitest";
import type { Matrix, TextureSource } from "../src/backend.js";
import { Draw } from "../src/draw.js";
import { blur, filter } from "../src/filters.js";
import { Shader } from "../src/shader.js";
import { ring, roundRect } from "../src/shapes.js";
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
    checkFramebufferStatus: () => "FRAMEBUFFER_COMPLETE",
    getParameter: (p: unknown) => (p === "MAX_TEXTURE_SIZE" ? 16384 : undefined),
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

  it("uploads an image again once it has loaded, instead of keeping the empty upload", () => {
    const { gl, count } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    const img = { naturalWidth: 0, naturalHeight: 0 } as unknown as HTMLImageElement;
    draw.sprite(img, 0, 0);
    draw.end();
    img.naturalWidth = 16;
    img.naturalHeight = 16;
    draw.begin("#000", 100, 50, 1);
    draw.sprite(img, 0, 0);
    draw.end();
    expect(count("texImage2D")).toBe(1);
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

  it("sprites() draws after queued quads in one call, uploading a Float32Array as is", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    const img = image(8, 8);
    const pos = new Float32Array([1, 2, 3, 4, 5, 6]);
    calls.length = 0;
    draw.begin("#000", 100, 50, 1);
    draw.rect(0, 0, 1, 1, "#fff");
    draw.sprites(img, pos, 3, { tint: "#ff0000" });
    draw.rect(0, 0, 1, 1, "#fff");
    draw.end();
    const names = calls.map((c) => c.name).filter((n) => n === "drawArraysInstanced" || n === "useProgram");
    // queued rect, switch to the copy program, copies, back to the sprite program, last rect
    expect(names).toEqual(["drawArraysInstanced", "useProgram", "drawArraysInstanced", "useProgram", "drawArraysInstanced"]);
    const copies = calls.filter((c) => c.name === "drawArraysInstanced")[1];
    expect(copies?.args[3]).toBe(3);
    const upload = calls.find((c) => c.name === "bufferData" && c.args[1] === pos);
    expect(upload?.args.slice(3)).toEqual([0, 6]);
    const color = calls.find((c) => c.name === "uniform4f" && c.args[1] === 1 && c.args[2] === 0);
    expect(color).toBeDefined();
    expect(draw.drawCalls).toBe(3);
  });

  it("sprites() copies plain arrays through a staging buffer", () => {
    const { gl, calls } = fakeGL();
    const draw = new Draw(new WebGL2Backend(gl), false);
    draw.begin("#000", 100, 50, 1);
    draw.sprites(image(), [1, 2, 3, 4]);
    const upload = calls.findLast((c) => c.name === "bufferData") as { args: unknown[] };
    expect(Array.from((upload.args[1] as Float32Array).subarray(0, 4))).toEqual([1, 2, 3, 4]);
    expect(draw.drawCalls).toBe(1);
    draw.end();
  });

  describe("sprites", () => {
    const sprite = (calls: { name: string; args: unknown[] }[], i = 0) => {
      const f = calls.findLast((c) => c.name === "bufferSubData")?.args[2] as Float32Array;
      return Array.from(f.subarray(i * 14, i * 14 + 13));
    };

    it("share one batch with quads (rects, text) drawn between them", () => {
      const { gl, count } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      for (let i = 0; i < 10; i++) {
        draw.sprite(img, i * 10, 10, { rotation: 0.5 });
        draw.rect(i * 10, 30, 8, 2, "#f00");
      }
      draw.end();
      expect(count("drawArraysInstanced")).toBe(1);
    });

    it("stay in the batch under a transform that changes per sprite, sent as finished quads", () => {
      const { gl, calls, count } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      for (let i = 0; i < 3; i++) {
        draw.push();
        draw.translate(i * 20, 0);
        draw.sprite(img, 10, 10, { rotation: 0.5 });
        draw.pop();
      }
      draw.end();
      expect(count("drawArraysInstanced")).toBe(1);
      // The first sets the batch's transform; the others are quads (no sprite flag) with the same corners.
      expect(sprite(calls, 0)[12]).toBeGreaterThanOrEqual(16);
      expect(sprite(calls, 1)[12]).toBeLessThan(16);
    });

    it("keep their texture and order around shapes under a custom shader, which shapes can't batch with", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const identity = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
      draw.begin("#000", 100, 50, 1);
      draw.withShader(identity, () => {
        roundRect(draw, 0, 0, 20, 20, 4, "#e23");
        draw.sprite(image(), 10, 10, { rotation: 0.5 });
        ring(draw, 10, 10, 5, 1, "#ffd36b");
      });
      draw.end();
      const draws = calls.filter((c) => c.name === "drawElements" || c.name === "drawArraysInstanced").map((c) => c.name);
      expect(draws).toEqual(["drawElements", "drawArraysInstanced", "drawElements"]);
      // Flushing the shapes frees their texture units; the sprite's unit must outlive that.
      const info = calls.findLast((c) => c.name === "uniform3fv")?.args[1] as Float32Array;
      expect(info[0]).toBe(1 / 16);
    });

    it("write the same instance on the short path as on the full one", () => {
      const run = (warm: boolean) => {
        const { gl, calls } = fakeGL();
        const draw = new Draw(new WebGL2Backend(gl), true);
        const img = image();
        draw.begin("#000", 100, 50, 1);
        // The first sprite opens the batch on the full path; the second takes the short one.
        if (warm) draw.sprite(img, 1, 1);
        draw.sprite(img, 10.4, 10.6, { rotation: 1, scaleX: 2, origin: [0, 1], flash: 0.5, tint: 0x80ff40ff });
        draw.end();
        return sprite(calls, warm ? 1 : 0);
      };
      expect(run(true)).toEqual(run(false));
    });

    it("move with a translate() between two sprites, without push or pop", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      const img = image();
      draw.begin("#000", 100, 50, 1);
      draw.sprite(img, 10, 10);
      draw.translate(20, 0);
      draw.sprite(img, 10, 10);
      draw.end();
      // The first is a placed sprite at 10 - 8 = 2. The second, under a new transform, is a quad (no sprite flag)
      // whose translation is 22: the transform change was seen.
      const second = sprite(calls, 1);
      expect([sprite(calls, 0)[0], second[2], second[12]]).toEqual([2, 22, 0]);
    });

    it("find a texture unit that a quad assigned", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), true);
      const a = image();
      const b = image(32, 32);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(a, 10, 10, { rotation: 0.5 });
      draw.push();
      draw.translate(5, 0);
      draw.sprite(b, 10, 10, { rotation: 0.5 }); // another transform: a quad, which gives b unit 1
      draw.pop();
      draw.sprite(b, 10, 10, { rotation: 0.5 }); // the short path must use b's unit, not a's
      draw.end();
      expect(sprite(calls, 2)[12]).toBe(1 + 16);
    });

    it("land unrotated pixel art on whole pixels, rounded on the CPU", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.translate(0.3, 0);
      draw.sprite(image(), 10.4, 10.6);
      draw.end();
      // Anchored at its centre: 0.3 + 10.4 - 8 = 2.7 → 3, and 10.6 - 8 = 2.6 → 3. Flags: unit 0 + sprite + placed.
      const f = sprite(calls);
      expect([f[0], f[1], f[12]]).toEqual([3, 3, 48]);
    });

    it("keep their own position for the GPU when rotated or smooth", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), true);
      draw.begin("#000", 100, 50, 1);
      draw.sprite(image(), 10.4, 10.6, { rotation: 1, scaleX: 2, origin: [0, 1] });
      draw.end();
      expect(sprite(calls).map((v) => Math.round(v * 1000) / 1000)).toEqual([10.4, 10.6, 1, 2, 1, 0, 1, 0, 0, 0, 16, 16, 16]);
    });
  });

  describe("render targets", () => {
    it("draws into a framebuffer at the target's size and switches back to the canvas", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 50, 25, 2);
      const t = draw.createTarget(32, 16);
      calls.length = 0;
      draw.into(t, () => draw.rect(0, 0, 4, 4, "#fff"));
      draw.rect(0, 0, 4, 4, "#fff");
      draw.end();
      const binds = calls.filter((c) => c.name === "bindFramebuffer").map((c) => c.args[1] !== null);
      expect(binds.at(0)).toBe(true);
      expect(binds.at(-1)).toBe(false);
      const viewports = calls.filter((c) => c.name === "viewport").map((c) => c.args);
      expect(viewports).toEqual([
        [0, 0, 32, 16],
        [0, 0, 100, 50],
      ]);
      const views = calls.filter((c) => c.name === "uniform2f").map((c) => c.args.slice(1));
      expect(views).toEqual([
        [32, 16],
        [50, 25],
      ]);
    });

    it("samples targets upside down, since WebGL stores them bottom row first", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      const t = draw.createTarget(10, 10);
      draw.into(t, () => {});
      draw.sprite(t, 5, 5);
      draw.end();
      // Sprites read each unit's texture size and top-row v from u_texinfo: v starts at 1 and runs down.
      const info = calls.findLast((c) => c.name === "uniform3fv")?.args[1] as Float32Array;
      expect([info[0], info[1], info[2]]).toEqual([0.1, -0.1, 1].map(Math.fround));
    });

    it("refuses to draw a target into itself, or dispose it while drawing into it", () => {
      const { gl } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      const t = draw.createTarget(10, 10);
      expect(() => draw.into(t, () => draw.sprite(t, 0, 0))).toThrow(/into itself/);
      expect(() => draw.into(t, () => draw.sprites(t, [0, 0]))).toThrow(/into itself/);
      expect(() => draw.into(t, () => draw.disposeTarget(t))).toThrow(/while drawing into it/);
      // After a throw inside into(), drawing is back on the canvas.
      expect(() => draw.sprite(t, 0, 0)).not.toThrow();
      draw.end();
    });

    it("premultiplies a see-through clear colour, like begin()", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.into(draw.createTarget(10, 10), () => {}, "#ff000080");
      const a = 0x80 / 255;
      expect(calls.findLast((c) => c.name === "clearColor")?.args).toEqual([a, 0, 0, a]);
      draw.end();
    });

    it("leaves Draw's state as it was when the target can't be created", () => {
      const { gl } = fakeGL();
      (gl as unknown as { checkFramebufferStatus: () => string }).checkFramebufferStatus = () => "FRAMEBUFFER_UNSUPPORTED";
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 2);
      draw.translate(5, 5);
      draw.alpha = 0.5;
      draw.clip(0, 0, 10, 10, () => {
        expect(() => draw.into(draw.createTarget(10, 10), () => {})).toThrow(/could not be created/);
        expect(draw.clips).toHaveLength(1);
      });
      expect(draw.m).toEqual([1, 0, 0, 1, 5, 5]);
      expect(draw.alpha).toBe(0.5);
      expect(draw.renderScale).toBe(2);
      expect(draw.target).toBeNull();
      expect(() => draw.pop()).toThrow(/without a matching push/);
      draw.end();
    });

    it("clears a filter's first pass in full even inside a clip", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.clip(10, 10, 20, 20, () => filter(draw, [blur(2)], () => draw.rect(0, 0, 50, 50, "#fff")));
      const names = calls.map((c) => `${c.name}:${String(c.args[0])}`);
      const firstClear = names.indexOf("clear:COLOR_BUFFER_BIT", names.indexOf("enable:SCISSOR_TEST"));
      expect(names.lastIndexOf("disable:SCISSOR_TEST", firstClear)).toBeGreaterThan(names.indexOf("enable:SCISSOR_TEST"));
      draw.end();
    });

    it("clips inside a target flip against the target's height", () => {
      const { gl, calls } = fakeGL();
      const draw = new Draw(new WebGL2Backend(gl), false);
      draw.begin("#000", 100, 50, 1);
      draw.into(draw.createTarget(40, 20), () => draw.clip(0, 0, 10, 5, () => draw.rect(0, 0, 1, 1, "#fff")));
      expect(calls.find((c) => c.name === "scissor")?.args).toEqual([0, 15, 10, 5]);
      draw.end();
    });

    it("frees framebuffers on disposeTarget and dispose, and recreates targets blank after context loss", () => {
      const { gl, created, fire, count } = fakeGL();
      const backend = new WebGL2Backend(gl);
      const draw = new Draw(backend, false);
      draw.begin("#000", 100, 50, 1);
      const a = draw.createTarget(8, 8);
      const b = draw.createTarget(8, 8);
      draw.into(a, () => {});
      draw.into(b, () => {});
      draw.disposeTarget(a);
      const fbos = () => created.filter((o) => o.kind === "Framebuffer");
      expect(fbos().map((o) => o.deleted)).toEqual([true, false]);
      fire("webglcontextlost");
      const restoredFrom = created.length;
      fire("webglcontextrestored");
      const before = count("createFramebuffer");
      draw.begin("#000", 100, 50, 1);
      draw.into(b, () => {});
      expect(count("createFramebuffer")).toBe(before + 1);
      draw.end();
      draw.dispose();
      // Objects from before the loss died with that context; everything made since is freed.
      expect(created.slice(restoredFrom).filter((o) => !o.deleted)).toEqual([]);
    });
  });
});
