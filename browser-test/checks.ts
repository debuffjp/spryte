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
(window as unknown as { __checks: unknown }).__checks = results;
