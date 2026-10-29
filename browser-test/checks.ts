// Pixel checks that need a real GPU. Each check draws the same scene two ways and compares every pixel.

import { canvasFilters } from "../src/canvas2d.js";
import {
  blur,
  brightness,
  contrast,
  createRenderer,
  createSharedRenderer,
  type Draw,
  type Filter,
  type Frame,
  filter,
  grayscale,
  hueRotate,
  invert,
  mask,
  nineSlice,
  polygon,
  polyline,
  ring,
  roundRect,
  Shader,
  saturate,
  sepia,
  tiled,
} from "../src/index.js";

const W = 160;
const H = 120;

function art(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 6;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#cffb2d";
  g.fillRect(0, 0, 8, 6);
  g.fillStyle = "#e23";
  g.fillRect(1, 1, 3, 2);
  g.fillStyle = "rgba(0,0,255,0.5)";
  g.fillRect(5, 3, 3, 3);
  return c;
}

async function render(scene: (draw: Draw) => void, backend: "webgl2" | "2d" = "webgl2", scale = 2): Promise<Uint8Array> {
  // A fresh canvas each time: a canvas can only ever have one context type.
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const draw = createRenderer(canvas, { backend, smooth: false });
  await draw.ready;
  draw.resize(W, H);
  draw.begin("#102030", W / scale, H / scale, scale);
  scene(draw);
  draw.end();
  const raw = draw.raw;
  let out: Uint8Array;
  if (raw.kind === "webgl2") {
    out = new Uint8Array(W * H * 4);
    raw.gl.readPixels(0, 0, W, H, raw.gl.RGBA, raw.gl.UNSIGNED_BYTE, out);
    // readPixels is bottom row first; flip so both backends compare top-down.
    const row = W * 4;
    const flipped = new Uint8Array(out.length);
    for (let y = 0; y < H; y++) flipped.set(out.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    out = flipped;
  } else out = new Uint8Array(raw.ctx.getImageData(0, 0, W, H).data.buffer);
  draw.dispose();
  // Release the GPU context now: Chrome caps live WebGL contexts, and past the cap it won't restore lost ones.
  if (raw.kind === "webgl2") raw.gl.getExtension("WEBGL_lose_context")?.loseContext();
  return out;
}

function diff(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  return n;
}

const img = art();
const pos = new Float32Array(40);
for (let i = 0; i < 20; i++) {
  pos[i * 2] = 4 + ((i * 13.37) % 70);
  pos[i * 2 + 1] = 3 + ((i * 7.71) % 52);
}
const cases: [string, Parameters<Draw["sprite"]>[3]][] = [
  ["plain (pixel snapped)", {}],
  ["tint, alpha, flash", { tint: "#88f", alpha: 0.6, flash: 0.3 }],
  ["rotated and scaled", { rotation: 0.7, scaleX: 1.5, scaleY: 0.75 }],
  ["smooth, flipped, origin", { smooth: true, flipX: true, origin: [0, 1] }],
];
const results: { name: string; differing: number; nonBackground: number }[] = [];
const record = (name: string, a: Uint8Array, b: Uint8Array) => {
  let nonBackground = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== 0x10 || a[i + 1] !== 0x20) nonBackground++;
  results.push({ name, differing: diff(a, b), nonBackground });
};

for (const [name, o] of cases) {
  const scene = (bulk: boolean) => (draw: Draw) => {
    draw.translate(2.5, 1);
    draw.rect(0, 0, 10, 10, "#fff");
    if (bulk) draw.sprites(img, pos, 20, o);
    else for (let i = 0; i < 20; i++) draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number, o);
    draw.rect(70, 50, 10, 10, "#f0f"); // drawn after: order must hold
  };
  record(`sprites() == sprite() loop: ${name}`, await render(scene(false)), await render(scene(true)));
}

// Render targets: a scene drawn into a target, then the target drawn 1:1, must match drawing it directly.
const busy = (draw: Draw) => {
  draw.rect(5, 5, 60, 30, "#ff000080");
  for (let i = 0; i < 20; i++)
    draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number, { rotation: i * 0.3, tint: i % 2 ? "#8f8" : "#fff" });
  draw.clip(20, 20, 50, 40, () => draw.circle(40, 40, 30, "#36f"));
  draw.blend("add");
  draw.sprites(img, pos, 10, { alpha: 0.5 });
  draw.blend("normal");
};
for (const backend of ["webgl2", "2d"] as const) {
  const direct = await render(busy, backend, 1);
  const viaTarget = await render(
    (draw) => {
      const t = draw.createTarget(W, H);
      draw.into(t, () => busy(draw), "#102030");
      draw.sprite(t, 0, 0, { origin: [0, 0] });
      draw.disposeTarget(t);
    },
    backend,
    1,
  );
  record(`render target == direct (${backend})`, direct, viaTarget);
  // Drawing after into() continues on the canvas with the outer state intact.
  const after = await render(
    (draw) => {
      draw.translate(10, 0);
      draw.clip(0, 0, 80, 120, () => {
        const t = draw.createTarget(4, 4);
        draw.into(t, () => draw.rect(0, 0, 4, 4, "#fff"));
        busy(draw);
      });
    },
    backend,
    1,
  );
  const reference = await render(
    (draw) => {
      draw.translate(10, 0);
      draw.clip(0, 0, 80, 120, () => busy(draw));
    },
    backend,
    1,
  );
  record(`into() restores transform and clip (${backend})`, reference, after);
}
// Per-copy scale, rotation and colour: sprites(…, each) must match a sprite() loop given the same values.
{
  const n = 20;
  const scale = Float32Array.from({ length: n }, (_, i) => 0.5 + (i % 4) * 0.5);
  const rotation = Float32Array.from({ length: n }, (_, i) => i * 0.37);
  const color = Uint32Array.from({ length: n }, (_, i) => [0xffffffff, 0xff8080ff, 0x80ff80c0, 0x8080ff80][i % 4] as number);
  const hex = (c: number) => `#${c.toString(16).padStart(8, "0")}`;
  // Copy 0 has rotation 0 at a half-pixel position, so it also checks per-copy pixel snapping.
  // Rotated copies: sprite() takes cos/sin on the CPU, sprites() in the shader. A GPU's sin/cos can differ from
  // Math's in the last bits (SwiftShader does), flipping a few edge pixels, so WebGL2 allows 8 of ~4,000–7,000.
  // Canvas 2D gets the same values on both paths and stays exact, which still catches real bugs (a snapping
  // bug showed on both backends).
  const ROTATED_EDGE = 8;
  const variants: [string, { scale?: Float32Array; rotation?: Float32Array; color?: Uint32Array }, number][] = [
    ["scale + colour (snapped)", { scale, color }, 0],
    ["scale + rotation + colour", { scale, rotation, color }, 0],
    ["rotation only", { rotation }, 0],
  ];
  for (const backend of ["webgl2", "2d"] as const)
    for (const [name, each, exact] of variants) {
      const tolerance = backend === "webgl2" && each.rotation ? Math.max(exact, ROTATED_EDGE) : exact;
      const loop = await render((draw) => {
        for (let i = 0; i < n; i++)
          draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number, {
            scaleX: each.scale ? (each.scale[i] as number) : 1,
            scaleY: each.scale ? (each.scale[i] as number) : 1,
            rotation: each.rotation ? (each.rotation[i] as number) : 0,
            tint: each.color ? hex(each.color[i] as number) : "#fff",
          });
      }, backend);
      const bulk = await render((draw) => draw.sprites(img, pos, n, {}, each), backend);
      const differing = diff(loop, bulk);
      let drawn = 0;
      for (let i = 0; i < loop.length; i += 4) if (loop[i] !== 0x10 || loop[i + 1] !== 0x20) drawn++;
      results.push({
        name: `sprites(each) == sprite() loop: ${name} (${backend}, ${differing} px differ, tolerance ${tolerance})`,
        differing: differing <= tolerance ? 0 : differing,
        nonBackground: drawn,
      });
    }
}

// Per-copy frame: sprites(frames, …, { frame }) must match a sprite() loop over the same frames. Frames of
// different sizes on one image take the instanced path; a frame on a second image forces one quad per copy.
{
  const n = 20;
  const other = art();
  const sub = (image: HTMLCanvasElement, x: number, y: number, w: number, h: number) => ({ image, x, y, w, h });
  const onOne = [sub(img, 0, 0, 8, 6), sub(img, 1, 1, 3, 2), sub(img, 4, 0, 4, 6)];
  const mixed = [...onOne, sub(other, 0, 3, 8, 3)];
  const scale = Float32Array.from({ length: n }, (_, i) => 1 + (i % 3));
  for (const backend of ["webgl2", "2d"] as const)
    for (const [name, frames, withScale] of [
      ["one image", onOne, false],
      ["one image + scale", onOne, true],
      ["across images", mixed, false],
    ] as const) {
      const index = Uint8Array.from({ length: n }, (_, i) => i % frames.length);
      const each = withScale ? { frame: index, scale } : { frame: index };
      const loop = await render((draw) => {
        for (let i = 0; i < n; i++) {
          const k = withScale ? (scale[i] as number) : 1;
          draw.sprite(frames[index[i] as number] as Frame, pos[i * 2] as number, pos[i * 2 + 1] as number, { scaleX: k, scaleY: k });
        }
      }, backend);
      const bulk = await render((draw) => draw.sprites(frames, pos, n, {}, each), backend);
      record(`sprites(each.frame) == sprite() loop: ${name} (${backend})`, loop, bulk);
    }
}

// Custom shaders.
const pixelAt = (px: Uint8Array, x: number, y: number) => Array.from(px.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
const check = (name: string, pass: boolean, detail: string) =>
  results.push({ name: `${name}: ${detail}`, differing: pass ? 0 : 1, nonBackground: 1000 });

// An index past the end of the frames throws with a message rather than a TypeError deep in a backend.
for (const backend of ["webgl2", "2d"] as const) {
  let message = "";
  try {
    await render((draw) => draw.sprites([{ image: img, x: 0, y: 0, w: 8, h: 6 }], pos, 2, {}, { frame: Uint8Array.of(0, 3) }), backend);
  } catch (e) {
    message = String(e);
  }
  check(`sprites(each.frame) out of range throws (${backend})`, message.includes("each.frame[1] is 3"), message);
}
{
  const identity = (draw: Draw) => draw.createShader(`vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }`);
  const scene = (draw: Draw) => {
    busy(draw);
    for (let i = 0; i < 5; i++) draw.sprite(img, 10 + i * 12, 50, { flash: i / 4, alpha: 0.8 });
  };
  const plain = await render(scene, "webgl2", 1);
  const shaded = await render((draw) => draw.withShader(identity(draw), () => scene(draw)), "webgl2", 1);
  record("identity shader == no shader (incl. sprites(), flash, clip, blend)", plain, shaded);

  const green = await render(
    (draw) => {
      const s = draw.createShader(`vec4 effect(vec4 color, vec2 uv) { return vec4(0.0, 1.0, 0.0, 1.0); }`);
      draw.withShader(s, () => draw.rect(10, 10, 20, 20, "#f00"));
      draw.rect(40, 10, 20, 20, "#f00");
    },
    "webgl2",
    1,
  );
  check(
    "shader output reaches the screen and stops at the scope's end",
    pixelAt(green, 15, 15).join() === "0,255,0,255" && pixelAt(green, 45, 15).join() === "255,0,0,255",
    `${pixelAt(green, 15, 15)} / ${pixelAt(green, 45, 15)}`,
  );

  const uni = await render(
    (draw) => {
      const s = draw.createShader(`uniform vec3 tint; vec4 effect(vec4 color, vec2 uv) { return vec4(tint, 1.0); }`);
      draw.withShader(s, () => {
        s.set("tint", [1, 0, 0]);
        draw.rect(10, 10, 20, 20, "#fff");
        s.set("tint", [0, 0, 1]);
        draw.rect(40, 10, 20, 20, "#fff");
      });
    },
    "webgl2",
    1,
  );
  check(
    "uniform changes apply only to later draws",
    pixelAt(uni, 15, 15).join() === "255,0,0,255" && pixelAt(uni, 45, 15).join() === "0,0,255,255",
    `${pixelAt(uni, 15, 15)} / ${pixelAt(uni, 45, 15)}`,
  );

  let message = "";
  await render(
    (draw) => {
      const bad = draw.createShader(`uniform float t;
vec4 effect(vec4 color, vec2 uv) {
  return nope(uv);
}`);
      try {
        draw.withShader(bad, () => draw.rect(0, 0, 1, 1, "#fff"));
      } catch (e) {
        message = String(e);
      }
    },
    "webgl2",
    1,
  );
  check(
    "compile errors name the user's line",
    /custom shader failed to compile/.test(message) && /0?:?3:/.test(message),
    JSON.stringify(message.slice(0, 120)),
  );

  const inTarget = await render(
    (draw) => {
      const s = draw.createShader(`vec4 effect(vec4 color, vec2 uv) { return vec4(0.0, 1.0, 0.0, 1.0); }`);
      const t = draw.createTarget(W, H);
      draw.into(t, () => draw.withShader(s, () => draw.rect(10, 10, 20, 20, "#f00")));
      draw.sprite(t, 0, 0, { origin: [0, 0] });
      draw.rect(40, 10, 20, 20, "#f00");
    },
    "webgl2",
    1,
  );
  check(
    "shaders work inside render targets",
    pixelAt(inTarget, 15, 15).join() === "0,255,0,255" && pixelAt(inTarget, 45, 15).join() === "255,0,0,255",
    `${pixelAt(inTarget, 15, 15)} / ${pixelAt(inTarget, 45, 15)}`,
  );
}

// ---- Adversarial QA (expected to FAIL on the current source) ----
{
  // sprites() with count > positions.length / 2: the copies that exist should still draw.
  for (const backend of ["webgl2", "2d"] as const) {
    const two = new Float32Array([20, 20, 50, 20]);
    const px = await render((draw) => draw.sprites(img, two, 5), backend, 1);
    check(
      `ADV sprites() with count beyond positions still draws the real copies (${backend})`,
      pixelAt(px, 20, 20).join() !== "16,32,48,255" && pixelAt(px, 50, 20).join() !== "16,32,48,255",
      `${pixelAt(px, 20, 20)} / ${pixelAt(px, 50, 20)}`,
    );
  }

  // A render target larger than MAX_TEXTURE_SIZE must fail loudly, not draw nothing silently.
  let error = "";
  await render(
    (draw) => {
      const gl = (draw.raw as { gl: WebGL2RenderingContext }).gl;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      try {
        const t = draw.createTarget(max * 2, 4);
        draw.into(t, () => draw.rect(0, 0, 4, 4, "#f00"));
        draw.sprite(t, 0, 0, { origin: [0, 0] });
      } catch (e) {
        error = String(e);
      }
    },
    "webgl2",
    1,
  );
  check("ADV oversized render target throws", error !== "", JSON.stringify(error.slice(0, 80)));

  // Same scene on both backends: smooth sprite after a clip that drew smooth sprites.
  const big = document.createElement("canvas");
  big.width = 4;
  big.height = 4;
  const g = big.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 2, 4);
  g.fillStyle = "#000";
  g.fillRect(2, 0, 2, 4);
  const clipScene = (draw: Draw) => {
    draw.sprite(big, 10, 10); // nearest
    draw.clip(0, 0, 40, 40, () => draw.sprite(big, 20, 20, { smooth: true, scaleX: 8, scaleY: 8 }));
    draw.sprite(big, 100, 60, { smooth: true, scaleX: 8, scaleY: 8 });
  };
  const gl2 = await render(clipScene, "webgl2", 1);
  const c2d = await render(clipScene, "2d", 1);
  // Compare only the last sprite's area, where filtering decides the gradient.
  let differ = 0;
  for (let y = 46; y < 74; y++)
    for (let x = 86; x < 114; x++) {
      const a = pixelAt(gl2, x, y);
      const b = pixelAt(c2d, x, y);
      if (Math.abs((a[0] as number) - (b[0] as number)) > 24) differ++;
    }
  check("ADV Canvas 2D smoothing survives a clip (matches WebGL2)", differ < 20, `${differ} px differ by > 24`);
}

// Canvas 2D tint and flash on partly transparent pixels match WebGL2, on the canvas and in a transparent
// render target (whose alpha then shows when it's drawn).
{
  const half = document.createElement("canvas");
  half.width = 8;
  half.height = 8;
  const g = half.getContext("2d") as CanvasRenderingContext2D;
  g.fillStyle = "#cffb2d";
  g.fillRect(0, 0, 8, 8);
  g.clearRect(0, 2, 8, 2);
  g.fillStyle = "rgba(255,255,0,0.5)";
  g.fillRect(0, 2, 8, 2);
  g.fillStyle = "rgba(200,40,90,0.25)";
  g.fillRect(0, 6, 8, 2);
  const paint = (draw: Draw) => {
    draw.sprite(half, 4, 4, { origin: [0, 0], scaleX: 4, scaleY: 4, tint: "#40c0ff", alpha: 0.6 });
    draw.sprite(half, 40, 4, { origin: [0, 0], scaleX: 4, scaleY: 4, flash: 0.7 });
    draw.sprite(half, 76, 4, { origin: [0, 0], scaleX: 4, scaleY: 4, tint: "#ff8040", flash: 0.4, alpha: 0.8 });
  };
  const scene = (draw: Draw) => {
    paint(draw);
    const t = draw.createTarget(W, 40);
    draw.into(t, () => paint(draw), 0);
    draw.sprite(t, 0, 50, { origin: [0, 0] });
    draw.disposeTarget(t);
  };
  const gl2 = await render(scene, "webgl2", 1);
  const c2d = await render(scene, "2d", 1);
  let worst = 0;
  for (let i = 0; i < gl2.length; i++) worst = Math.max(worst, Math.abs((gl2[i] as number) - (c2d[i] as number)));
  check("Canvas 2D tint/flash on partial alpha matches WebGL2", worst <= 2, `max channel error ${worst}`);
}

// Real context loss (WEBGL_lose_context): drawing while lost is skipped without errors, and after restore
// the same scene draws the same pixels as a fresh renderer. Render targets come back blank (documented).
{
  const read = (gl: WebGL2RenderingContext) => {
    const out = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const scene = (draw: Draw) => {
    busy(draw);
    draw.sprites(img, pos, 20, { tint: "#8f8" }, { scale: new Float32Array(20).fill(1.5) });
  };
  const fresh = await render(scene, "webgl2", 1);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const draw = createRenderer(canvas, { backend: "webgl2", smooth: false });
  const raw = draw.raw;
  if (raw.kind !== "webgl2") throw new Error("needs WebGL2");
  const gl = raw.gl;
  const ext = gl.getExtension("WEBGL_lose_context");
  const frame = () => {
    draw.resize(W, H);
    draw.begin("#102030", W, H, 1);
    scene(draw);
    draw.end();
  };
  frame();
  const event = (name: string) =>
    new Promise<string>((r) => {
      canvas.addEventListener(name, () => r("fired"), { once: true });
      setTimeout(() => r("timed out"), 3000);
    });
  const lost = event("webglcontextlost");
  ext?.loseContext();
  const lostState = await lost;
  let threwWhileLost = false;
  try {
    frame();
  } catch {
    threwWhileLost = true;
  }
  // A restore requested straight after the loss never fired webglcontextrestored here; real losses last a while.
  await new Promise((r) => setTimeout(r, 250));
  const restored = event("webglcontextrestored");
  ext?.restoreContext();
  const restoredState = await restored;
  await new Promise((r) => setTimeout(r, 0));
  frame();
  const after = read(gl);
  // readPixels is bottom row first; flip to compare with render()'s top-down output.
  const flipped = new Uint8Array(after.length);
  for (let y = 0; y < H; y++) flipped.set(after.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  check(
    "context loss: no throw while lost",
    !!ext && !threwWhileLost && draw.contextLost === false,
    ext ? `lost ${lostState}, restored ${restoredState}, contextLost after: ${draw.contextLost}` : "WEBGL_lose_context unavailable",
  );
  record("context loss: same pixels after restore as a fresh renderer", fresh, flipped);
  draw.dispose();
}

// transparent: true. A see-through clear replaces last frame (not blends over it), and drawn pixels are opaque.
for (const backend of ["webgl2", "2d"] as const) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const draw = createRenderer(canvas, { backend, smooth: false, transparent: true });
  await draw.ready;
  draw.resize(W, H);
  draw.begin("#f00", W, H, 1); // an opaque first frame, to prove the next clear removes it
  draw.end();
  draw.begin("#0000", W, H, 1);
  draw.rect(10, 10, 20, 20, "#0f0");
  draw.end();
  const raw = draw.raw;
  const px = (x: number, y: number) => {
    const out = new Uint8Array(4);
    if (raw.kind === "webgl2") raw.gl.readPixels(x, H - 1 - y, 1, 1, raw.gl.RGBA, raw.gl.UNSIGNED_BYTE, out);
    else out.set(raw.ctx.getImageData(x, y, 1, 1).data);
    return [...out];
  };
  const outside = px(2, 2);
  const inside = px(20, 20);
  check(
    `transparent canvas: see-through clear, opaque draws (${backend})`,
    outside[3] === 0 && inside[1] === 255 && inside[3] === 255,
    `outside ${outside} / inside ${inside}`,
  );
  draw.dispose();
  if (raw.kind === "webgl2") raw.gl.getExtension("WEBGL_lose_context")?.loseContext();
}

// Text atlas (WebGL2): strings added after a page is on the GPU upload only their own rectangle. Draw them
// straight away (the first string uploads the page, the rest go through region uploads), and compare with a
// renderer that rasterised them all first (one whole-page upload). Same pixels means the region path is right.
{
  const labels = Array.from({ length: 60 }, (_, i) => `${(i * 7919) % 1000}`);
  const scene = (warm: boolean) => (draw: Draw) => {
    if (warm) for (const t of labels) draw.measure(t, "bold 9px monospace");
    labels.forEach((t, i) => {
      draw.text(t, 2 + (i % 6) * 13, 2 + Math.floor(i / 6) * 5.5, { font: "bold 9px monospace", color: i % 2 ? "#cffb2d" : "#fff" });
    });
  };
  record("text atlas: region uploads == whole-page upload (webgl2)", await render(scene(true)), await render(scene(false)));
}

// Blend modes: WebGL2 matches Canvas 2D on the opaque canvas, for opaque and partly transparent drawing.
{
  const scene = (draw: Draw) => {
    draw.rect(0, 0, 160, 60, "#80a0c0");
    draw.rect(0, 60, 160, 60, "#e04020");
    (["normal", "add", "multiply", "screen", "erase"] as const).forEach((mode, i) => {
      draw.blend(mode);
      draw.rect(4 + i * 30, 10, 24, 100, "#c8f040");
      draw.rect(4 + i * 30, 40, 24, 40, "#2060ff80");
    });
    draw.blend("normal");
  };
  const gl2 = await render(scene, "webgl2", 1);
  const c2d = await render(scene, "2d", 1);
  const modes = ["normal", "add", "multiply", "screen", "erase"];
  const worst = modes.map(() => 0);
  for (let i = 0; i < gl2.length; i++) {
    // Erase leaves the canvas see-through; compare colour only where something is left.
    if (i % 4 !== 3 && ((gl2[i - (i % 4) + 3] as number) === 0 || (c2d[i - (i % 4) + 3] as number) === 0)) continue;
    const column = Math.min(modes.length - 1, Math.floor((((i / 4) % W) - 2) / 30));
    if (column >= 0) worst[column] = Math.max(worst[column] as number, Math.abs((gl2[i] as number) - (c2d[i] as number)));
  }
  // Erasing an opaque canvas shows whatever the browser composites under it (black in Chrome, not in WebKit), so
  // erase is checked where it's meant to be used: in a render target, which is then drawn over a background.
  worst[4] = 0;
  const holes = (draw: Draw) => {
    const t = draw.createTarget(80, 60);
    draw.into(t, () => {
      draw.rect(0, 0, 80, 60, "#c8f040");
      draw.blend("erase");
      draw.circle(40, 30, 18, "#fff");
      draw.rect(4, 4, 30, 10, "#fff8");
      draw.blend("normal"); // into() keeps the blend mode, by design
    });
    draw.rect(0, 0, 160, 120, "#2060ff");
    draw.sprite(t, 0, 0, { origin: [0, 0], scaleX: 2, scaleY: 2 });
    draw.disposeTarget(t);
  };
  const [eg, ec] = [await render(holes, "webgl2", 1), await render(holes, "2d", 1)];
  for (let i = 0; i < eg.length; i++) worst[4] = Math.max(worst[4] as number, Math.abs((eg[i] as number) - (ec[i] as number)));
  check(
    "blend modes: WebGL2 matches Canvas 2D (erase in a render target)",
    Math.max(...worst) <= 2,
    `max channel error ${modes.map((m, k) => `${m} ${worst[k]}`).join(", ")}`,
  );
}

// Shapes: WebGL2's tessellation matches Canvas 2D's rasteriser away from edges, and edges stay close.
{
  const scene = (draw: Draw) => {
    polygon(draw, [10, 10, 70, 14, 40, 30, 66, 54, 12, 50], "#cffb2d");
    roundRect(draw, 84, 8, 64, 40, 12, "#e23");
    roundRect(draw, 84, 60, 64, 40, 10, "#fff", 4);
    ring(draw, 40, 84, 22, 5, "#40c0ff");
    polyline(draw, [8, 112, 40, 100, 72, 112], 3, "#ffd36b");
    draw.push();
    draw.translate(120, 80);
    draw.rotate(0.4);
    polygon(draw, [-10, -10, 10, -10, 10, 10, -10, 10], "#f0f8");
    draw.pop();
  };
  for (const scale of [1, 2]) {
    const gl2 = await render(scene, "webgl2", scale);
    const c2d = await render(scene, "2d", scale);
    let interior = 0;
    let edge = 0;
    for (let i = 0; i < gl2.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs((gl2[i + k] as number) - (c2d[i + k] as number))));
      // Interior: the 3×3 neighbourhood is one colour in the Canvas 2D frame.
      const x = (i / 4) % W;
      const y = Math.floor(i / 4 / W);
      let flat = x > 0 && y > 0 && x < W - 1 && y < H - 1;
      for (let dy = -1; flat && dy <= 1; dy++)
        for (let dx = -1; flat && dx <= 1; dx++) {
          const j = i + (dy * W + dx) * 4;
          if (c2d[j] !== c2d[i] || c2d[j + 1] !== c2d[i + 1] || c2d[j + 2] !== c2d[i + 2]) flat = false;
        }
      if (flat) interior = Math.max(interior, d);
      else edge += d > 48 ? 1 : 0;
    }
    check(
      `shapes: WebGL2 matches Canvas 2D (scale ${scale})`,
      interior <= 2 && edge < 40 * scale,
      `interior max error ${interior}, ${edge} edge px off by > 48, ${gl2.filter((v, k) => k % 4 === 1 && v !== 0x20).length} px drawn`,
    );
  }
}

// tiled() == the same tiles drawn by hand under a clip; nineSlice() on WebGL2 == Canvas 2D.
{
  const tile = { image: img, x: 1, y: 1, w: 6, h: 4 };
  const byHand = (draw: Draw) =>
    draw.clip(5, 7, 61, 45, () => {
      for (let y = 7 - 3; y < 52; y += 4) for (let x = 5 - 2; x < 66; x += 6) draw.sprite(tile, x, y, { origin: [0, 0] });
    });
  const tiledScene = (draw: Draw) => tiled(draw, tile, 5, 7, 61, 45, { offsetX: 2, offsetY: 3 });
  record("tiled() == clipped sprite() grid (webgl2)", await render(tiledScene), await render(byHand));
  const panel = (draw: Draw) => {
    nineSlice(draw, img, 4, 4, 60, 30, 2);
    nineSlice(draw, img, 4, 40, 70, 16, [1, 1, 3, 2], { tint: "#8cf" });
  };
  record("nineSlice(): WebGL2 == Canvas 2D", await render(panel, "webgl2"), await render(panel, "2d"));
}

// mask(): a rectangle mask == clip(); a soft mask matches across backends; masks nest and work inside into().
{
  const content = (draw: Draw) => {
    draw.rect(0, 0, 80, 60, "#334");
    for (let i = 0; i < 20; i++) draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number, { scaleX: 2, scaleY: 2 });
    draw.text("mask", 20, 20, { color: "#fff" });
  };
  const clipped = (draw: Draw) => draw.clip(10, 8, 50, 30, () => content(draw));
  const masked = (draw: Draw) =>
    mask(
      draw,
      () => draw.rect(10, 8, 50, 30, "#fff"),
      () => content(draw),
    );
  for (const backend of ["webgl2", "2d"] as const)
    record(`mask(rect) == clip(rect) (${backend})`, await render(masked, backend), await render(clipped, backend));
  const soft = (draw: Draw) => {
    draw.rect(0, 0, 80, 60, "#a33");
    mask(
      draw,
      () => {
        draw.circle(40, 30, 22, "#fff8");
        polygon(draw, [4, 4, 30, 4, 4, 30], "#fff");
      },
      () =>
        mask(
          draw,
          () => draw.rect(0, 0, 60, 60, "#fff"),
          () => content(draw),
        ),
    );
    const t = draw.createTarget(40, 30);
    draw.into(t, () =>
      mask(
        draw,
        () => draw.circle(20, 15, 12, "#fff"),
        () => draw.rect(0, 0, 40, 30, "#cffb2d"),
      ),
    );
    draw.sprite(t, 40, 30, { origin: [0, 0] });
    draw.disposeTarget(t);
  };
  const gl2 = await render(soft, "webgl2");
  const c2d = await render(soft, "2d");
  let off = 0;
  for (let i = 0; i < gl2.length; i += 4) {
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs((gl2[i + k] as number) - (c2d[i + k] as number))));
    if (d > 48) off++;
  }
  check("soft, nested and in-target masks: WebGL2 matches Canvas 2D", off < 80, `${off} px off by > 48`);
}

// Offscreen passes inside a clip, and nested at render scale 2 (render() draws at 2x): each must equal drawing
// the same content directly. A full-cover mask shape or a zero-strength filter keeps everything, so any
// difference is a leaked clip, a stale pooled target or content drawn in the wrong units.
{
  const content = (draw: Draw) => {
    draw.rect(0, 0, 80, 60, "#334");
    for (let i = 0; i < 20; i++) draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number, { scaleX: 2, scaleY: 2 });
  };
  const keep = (draw: Draw) => draw.rect(0, 0, 80, 60, "#fff");
  const after = (draw: Draw) => draw.rect(62, 42, 16, 16, "#f0f"); // outside the clip: must still land
  const direct = (draw: Draw) => {
    draw.clip(10, 8, 50, 30, () => content(draw));
    after(draw);
  };
  const maskInClip = (draw: Draw) => {
    draw.clip(10, 8, 50, 30, () =>
      mask(
        draw,
        () => keep(draw),
        () => content(draw),
      ),
    );
    after(draw);
  };
  const blurred = (draw: Draw) => {
    draw.clip(10, 8, 50, 30, () => filter(draw, [blur(3)], () => content(draw)));
    after(draw);
  };
  const polluted = (draw: Draw) => {
    // A full-screen blur first, so the pooled target holds bright pixels outside the clip for the blur to sample.
    filter(draw, [blur(3)], () => draw.rect(0, 0, 80, 60, "#fff"));
    draw.rect(0, 0, 80, 60, "#102030");
    blurred(draw);
  };
  const nested = (draw: Draw) => {
    const t = draw.createTarget(8, 8);
    mask(
      draw,
      () => keep(draw),
      () => {
        draw.into(t, () => draw.rect(0, 0, 8, 8, "#fff"));
        content(draw);
        mask(
          draw,
          () => keep(draw),
          () => after(draw),
        );
      },
    );
    draw.disposeTarget(t);
  };
  const plain = (draw: Draw) => {
    content(draw);
    after(draw);
  };
  for (const backend of ["webgl2", "2d"] as const) {
    record(`mask inside clip == clip (${backend})`, await render(maskInClip, backend), await render(direct, backend));
    record(
      `filter inside clip after an unclipped filter == alone (${backend})`,
      await render(polluted, backend),
      await render(blurred, backend),
    );
    record(`into() and mask nested in a mask at 2x == direct (${backend})`, await render(nested, backend), await render(plain, backend));
  }
}

// filter(): WebGL2's passes match the browser's CSS filters on Canvas 2D.
{
  const content = (draw: Draw) => {
    draw.rect(10, 10, 30, 20, "#e23");
    draw.rect(40, 10, 30, 20, "#2a6cff");
    draw.circle(40, 40, 14, "#cffb2d");
    for (let i = 0; i < 20; i++) draw.sprite(img, pos[i * 2] as number, pos[i * 2 + 1] as number);
  };
  const cases: [string, Filter[], number][] = [
    ["grayscale", [grayscale()], 3],
    ["sepia", [sepia(0.7)], 3],
    ["saturate", [saturate(1.8)], 3],
    ["hueRotate", [hueRotate(2)], 3],
    ["brightness, contrast", [brightness(1.3), contrast(0.6)], 3],
    ["invert", [invert()], 3],
    ["blur", [blur(2)], 8],
    ["blur then grayscale", [blur(1.5), grayscale(0.5)], 8],
    ["large blur (30 device px)", [blur(15)], 8],
  ];
  // Firefox's own ctx.filter differs from the Filter Effects matrices by up to 16/255 on some pixels (measured
  // 2026-10-21, Firefox 157); WebGL2 follows the spec, so the fallback gets that browser's tolerance.
  const firefox = navigator.userAgent.includes("Firefox");
  for (const [name, filters, base] of cases) {
    const tolerance = firefox ? Math.max(base, 16) : base;
    if (!canvasFilters()) {
      check(`filter ${name}: Canvas 2D has no ctx.filter here, so it draws unfiltered (warned)`, true, "not supported");
      continue;
    }
    const scene = (draw: Draw) => {
      draw.rect(0, 0, 80, 60, "#203040");
      filter(draw, filters, () => content(draw));
    };
    const unfiltered = (draw: Draw) => {
      draw.rect(0, 0, 80, 60, "#203040");
      content(draw);
    };
    const gl2 = await render(scene, "webgl2");
    const c2d = await render(scene, "2d");
    const plain = await render(unfiltered);
    const plain2d = await render(unfiltered, "2d");
    // Judge the filter, not the rasteriser: skip pixels where the unfiltered frames already differ. Chrome's
    // software Canvas 2D (CI, no GPU) draws circle and sprite edges a few levels off, and a colour matrix spreads
    // that over every channel.
    let worst = 0;
    let off = 0;
    for (let p = 0; p < gl2.length; p += 4) {
      let rasterised = false;
      for (let c = 0; c < 3; c++) if (Math.abs((plain[p + c] as number) - (plain2d[p + c] as number)) > 3) rasterised = true;
      if (rasterised) continue;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs((gl2[p + c] as number) - (c2d[p + c] as number));
        worst = Math.max(worst, d);
        if (d > tolerance) off++;
      }
    }
    check(`filter ${name}: WebGL2 matches Canvas 2D`, off < 60, `max error ${worst}, ${off} channels over ${tolerance}`);
    // And it did something: a matching pair of unfiltered frames would pass the check above too.
    check(`filter ${name}: changes the image`, diff(gl2, plain) > 500, `${diff(gl2, plain)} px changed`);
  }
}

// Sprites that join a pending shape batch draw exactly what they draw in their own batches (an identity custom
// shader keeps them out of the shape batch), with tint, flash, alpha, smoothing, several textures and order.
{
  const other = art();
  const scene = (split: boolean) => (draw: Draw) => {
    const body = () => {
      for (let i = 0; i < 12; i++) {
        const x = 4 + (i % 4) * 19;
        const y = 4 + Math.floor(i / 4) * 18;
        roundRect(draw, x, y, 16, 14, 4, i % 2 ? "#2a6cff" : "#e23");
        draw.sprite(i % 3 ? img : other, x + 8, y + 7, {
          tint: i % 2 ? "#fff" : "#8cf",
          flash: i === 5 ? 0.4 : 0,
          alpha: i === 7 ? 0.5 : 1,
          smooth: i % 4 === 0,
          rotation: i * 0.3,
        });
        ring(draw, x + 8, y + 7, 5, 1, "#ffd36b");
      }
    };
    if (split) draw.withShader(identity, body);
    else body();
  };
  const identity = new Shader("vec4 effect(vec4 color, vec2 uv) { return source(uv) * color; }");
  const [joined, split] = [await render(scene(false)), await render(scene(true))];
  let worst = 0;
  for (let i = 0; i < joined.length; i++) worst = Math.max(worst, Math.abs((joined[i] as number) - (split[i] as number)));
  check("sprites joining a shape batch == their own batches (webgl2)", worst <= 1, `max channel error ${worst}`);
}

// Top-down pixels of a WebGL2 canvas (readPixels is bottom row first).
function readTopDown(gl: WebGL2RenderingContext): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
  const flipped = new Uint8Array(out.length);
  for (let y = 0; y < H; y++) flipped.set(out.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
  return flipped;
}

// begin(null) draws over the previous frame instead of clearing it.
{
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const draw = createRenderer(canvas, { backend: "webgl2", smooth: false });
  draw.resize(W, H);
  draw.begin("#102030", W, H, 1);
  busy(draw);
  draw.end();
  draw.begin(null, W, H, 1);
  draw.end();
  draw.begin(null, W, H, 1);
  draw.rect(100, 90, 20, 20, "#f0f");
  draw.end();
  const gl = (draw.raw as { gl: WebGL2RenderingContext }).gl;
  const kept = readTopDown(gl);
  draw.dispose();
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  record(
    "begin(null) keeps the previous frame",
    kept,
    await render(
      (d) => {
        busy(d);
        d.rect(100, 90, 20, 20, "#f0f");
      },
      "webgl2",
      1,
    ),
  );
}

// transform() applied step by step is the same as translate, rotate and scale.
{
  const scene = (viaTransform: boolean) => (draw: Draw) => {
    if (viaTransform) {
      draw.transform(1, 0, 0, 1, 20, 10);
      draw.transform(Math.cos(0.5), Math.sin(0.5), -Math.sin(0.5), Math.cos(0.5), 0, 0);
      draw.transform(1.5, 0, 0, 0.75, 0, 0);
    } else {
      draw.translate(20, 10);
      draw.rotate(0.5);
      draw.scale(1.5, 0.75);
    }
    busy(draw);
  };
  record("transform() == translate, rotate, scale", await render(scene(false)), await render(scene(true)));
}

/**
 * A small WebGL1-minded host engine on a WebGL2 context: its own program and VAO, a nearest-filtered texture set
 * through texParameteri (no sampler objects), scissored draws, and no assumptions reset between draws beyond
 * rebinding its program, VAO and texture, like Phaser.
 */
function host(gl: WebGL2RenderingContext) {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type) as WebGLShader;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram() as WebGLProgram;
  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, "attribute vec2 a; varying vec2 v; void main() { v = a; gl_Position = vec4(a * 2.0 - 1.0, 0.0, 1.0); }"),
  );
  gl.attachShader(
    program,
    compile(
      gl.FRAGMENT_SHADER,
      "precision mediump float; uniform sampler2D t; varying vec2 v; void main() { gl_FragColor = texture2D(t, v); }",
    ),
  );
  gl.bindAttribLocation(program, 0, "a");
  gl.linkProgram(program);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const checker = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, checker);
  const px = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) px.set((i + Math.floor(i / 4)) % 2 ? [255, 255, 255, 255] : [200, 30, 30, 255], i * 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const draw = (tex: WebGLTexture | null, x: number, y: number, w: number, h: number) => {
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.viewport(x, H - y - h, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, H - y - h, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  return {
    clear() {
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0x10 / 255, 0x20 / 255, 0x30 / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    },
    /** The checker magnified into a pixel rectangle (top-left origin): a linear sampler left bound would blur it. */
    checker: (x: number, y: number, w: number, h: number) => draw(checker, x, y, w, h),
    /** A framebuffer with a W×H nearest texture, and a 1:1 draw of that texture to the canvas. */
    framebuffer() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, blit: () => draw(tex, 0, 0, W, H) };
    },
    scissor(x: number, y: number, w: number, h: number) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x, H - y - h, w, h);
    },
  };
}

function hostCanvas(): WebGL2RenderingContext {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
  return canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: true }) as WebGL2RenderingContext;
}

// spryte on a host's context, between the host's own draws. Inside the host's scissor (x < 100), spryte's pixels
// match the owned renderer with the same clip; the host's draw after spryte matches the host alone (no program,
// VAO, texture-filter or scissor leak); nothing is drawn outside the host's scissor.
{
  const scene = (draw: Draw) => {
    busy(draw);
    draw.clip(80, 10, 70, 50, () => draw.rect(0, 0, W, H, "#ff0"));
    // Offscreen passes: their targets are the host framebuffer's size and composite back under its scissor.
    mask(
      draw,
      () => draw.circle(60, 70, 25, "#fff"),
      () => draw.rect(30, 40, 60, 60, "#0ff"),
    );
    draw.sprite(img, 30, 90, { smooth: true, scaleX: 3, scaleY: 3 }); // last batch: the linear sampler on unit 0
  };
  const owned = await render((d) => d.clip(0, 0, 100, H, () => scene(d)), "webgl2", 1);
  const expected = (() => {
    const gl = hostCanvas();
    const h = host(gl);
    h.clear();
    h.checker(110, 10, 40, 30);
    h.checker(110, 60, 40, 50);
    const out = readTopDown(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    for (let y = 0; y < H; y++) out.set(owned.subarray(y * W * 4, (y * W + 100) * 4), y * W * 4);
    return out;
  })();
  const gl = hostCanvas();
  const h = host(gl);
  h.clear();
  h.checker(110, 10, 40, 30);
  h.scissor(0, 0, 100, H);
  const shared = createSharedRenderer(gl, { smooth: false });
  shared.draw.begin(null, W, H, 1);
  scene(shared.draw);
  shared.draw.end();
  h.checker(110, 60, 40, 50);
  record("shared context: spryte under the host's scissor, host unchanged after", readTopDown(gl), expected);

  // The same into a host framebuffer, which the host then shows.
  const fb = h.framebuffer();
  h.clear();
  h.scissor(0, 0, 100, H);
  shared.target(fb.fbo, W, H);
  shared.draw.begin(null, W, H, 1);
  scene(shared.draw);
  shared.draw.end();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.disable(gl.SCISSOR_TEST);
  fb.blit();
  record("shared context: into a host framebuffer", readTopDown(gl), owned);
  shared.draw.dispose();
  gl.getExtension("WEBGL_lose_context")?.loseContext();
}

// Context loss on a shared context: the host prevents the default, spryte notes the events and rebuilds at its
// next begin(). Twice: once drawing while lost, once with the loss and restore between two frames.
{
  const gl = hostCanvas();
  const ext = gl.getExtension("WEBGL_lose_context");
  const shared = createSharedRenderer(gl, { smooth: false });
  const frame = () => {
    shared.draw.begin("#102030", W, H, 1);
    busy(shared.draw);
    shared.draw.end();
  };
  frame();
  const event = (name: string) =>
    new Promise<string>((r) => {
      gl.canvas.addEventListener(name, () => r("fired"), { once: true });
      setTimeout(() => r("timed out"), 3000);
    });
  const lost = event("webglcontextlost");
  ext?.loseContext();
  const lostState = await lost;
  let threw = false;
  try {
    frame();
  } catch {
    threw = true;
  }
  const lostSeen = shared.draw.contextLost;
  await new Promise((r) => setTimeout(r, 250));
  const restored = event("webglcontextrestored");
  ext?.restoreContext();
  const restoredState = await restored;
  await new Promise((r) => setTimeout(r, 0));
  frame();
  check(
    "shared context loss: noticed, no throw, recovered",
    !!ext && !threw && lostSeen && !shared.draw.contextLost,
    `lost ${lostState} (seen ${lostSeen}), restored ${restoredState}, contextLost after: ${shared.draw.contextLost}`,
  );
  record("shared context loss: same pixels after restore", readTopDown(gl), await render(busy, "webgl2", 1));
  // No frame between the loss and the restore: isContextLost() is false again by the next begin(), and the old
  // objects are dead. The host engine (or a benchmark's context-loss check) does exactly this.
  const lost2 = event("webglcontextlost");
  ext?.loseContext();
  await lost2;
  await new Promise((r) => setTimeout(r, 0));
  const restored2 = event("webglcontextrestored");
  ext?.restoreContext();
  const restored2State = await restored2;
  await new Promise((r) => setTimeout(r, 0));
  frame();
  check(
    "shared context loss between frames: recovered",
    restored2State === "fired" && !shared.draw.contextLost,
    `restored ${restored2State}, contextLost after: ${shared.draw.contextLost}`,
  );
  record("shared context loss between frames: same pixels after", readTopDown(gl), await render(busy, "webgl2", 1));
  shared.draw.dispose();
  ext?.loseContext();
}

(window as unknown as { __checks: unknown }).__checks = results;
