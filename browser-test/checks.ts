// Pixel checks that need a real GPU. Each check draws the same scene two ways and compares every pixel.
import { createRenderer, type Draw } from "../src/index.js";

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

// Custom shaders.
const pixelAt = (px: Uint8Array, x: number, y: number) => Array.from(px.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
const check = (name: string, pass: boolean, detail: string) =>
  results.push({ name: `${name}: ${detail}`, differing: pass ? 0 : 1, nonBackground: 1000 });
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

(window as unknown as { __checks: unknown }).__checks = results;
