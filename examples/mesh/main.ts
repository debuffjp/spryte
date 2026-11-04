// mesh(): one image bent over triangles. A flag waves in the wind and a ribbon trails the pointer.
import { createRenderer, mesh } from "spryte";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
// ?backend=2d forces the Canvas 2D fallback, to compare the two.
const backend = new URLSearchParams(location.search).get("backend") === "2d" ? "2d" : "auto";
const draw = createRenderer(canvas, { backend });

// A 64x40 checked image made at runtime, so the example has no assets and the bending is easy to see.
const flag = new OffscreenCanvas(64, 40);
const g = flag.getContext("2d") as OffscreenCanvasRenderingContext2D;
for (let y = 0; y < 5; y++)
  for (let x = 0; x < 8; x++) {
    g.fillStyle = (x + y) % 2 ? "#cffb2d" : "#ffffff";
    g.fillRect(x * 8, y * 8, 8, 8);
  }

// A grid of COLS x ROWS cells: vertices and uvs are reused every frame, only positions change.
const COLS = 16;
const ROWS = 6;
const xy = new Float32Array((COLS + 1) * (ROWS + 1) * 2);
const uv = new Float32Array(xy.length);
const grid: number[] = [];
for (let j = 0; j <= ROWS; j++)
  for (let i = 0; i <= COLS; i++) {
    const v = j * (COLS + 1) + i;
    uv[v * 2] = (i / COLS) * 64;
    uv[v * 2 + 1] = (j / ROWS) * 40;
    if (i < COLS && j < ROWS) grid.push(v, v + 1, v + COLS + 1, v + 1, v + COLS + 2, v + COLS + 1);
  }
const indices = new Uint16Array(grid);

// The ribbon: a strip of SEGS points following the pointer, two vertices across each.
const SEGS = 40;
const trail = Array.from({ length: SEGS }, () => ({ x: 0, y: 0 }));
const strip = new Float32Array(SEGS * 4);
const stripUv = new Float32Array(SEGS * 4);
const stripIx: number[] = [];
for (let i = 0; i < SEGS; i++) {
  stripUv.set([(i / (SEGS - 1)) * 64, 16, (i / (SEGS - 1)) * 64, 24], i * 4);
  if (i < SEGS - 1) stripIx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
}
const stripIndices = new Uint16Array(stripIx);
let pointer = { x: 0, y: 0 };
addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
});

function resize(): number {
  const dpr = devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    draw.resize(w, h);
  }
  return dpr;
}

function frame(ms: number): void {
  const dpr = resize();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const t = ms / 1000;
  draw.begin("#111", w, h, dpr);

  // Flag: 320x200 at the centre, pinned on its left edge, waving more toward its free edge.
  const fw = 320;
  const fh = 200;
  const left = w / 2 - fw / 2;
  const top = h / 2 - fh / 2;
  for (let j = 0; j <= ROWS; j++)
    for (let i = 0; i <= COLS; i++) {
      const v = j * (COLS + 1) + i;
      const k = i / COLS;
      const wave = Math.sin(k * 6 - t * 4 + j * 0.3) * 18 * k;
      xy[v * 2] = left + k * fw - Math.abs(wave) * 0.3;
      xy[v * 2 + 1] = top + (j / ROWS) * fh + wave;
    }
  draw.rect(left - 6, top - 8, 6, fh + 120, "#888");
  mesh(draw, flag, xy, uv, indices);

  // Ribbon: each point eases toward the one ahead of it.
  trail[0] = { x: pointer.x || w / 2, y: pointer.y || h / 4 };
  for (let i = 1; i < SEGS; i++) {
    const a = trail[i] as { x: number; y: number };
    const b = trail[i - 1] as { x: number; y: number };
    a.x += (b.x - a.x) * 0.35;
    a.y += (b.y - a.y) * 0.35;
  }
  for (let i = 0; i < SEGS; i++) {
    const a = trail[Math.max(0, i - 1)] as { x: number; y: number };
    const b = trail[Math.min(SEGS - 1, i + 1)] as { x: number; y: number };
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const half = 10 * (1 - i / SEGS);
    const nx = (-(b.y - a.y) / len) * half;
    const ny = ((b.x - a.x) / len) * half;
    const p = trail[i] as { x: number; y: number };
    strip.set([p.x + nx, p.y + ny, p.x - nx, p.y - ny], i * 4);
  }
  mesh(draw, flag, strip, stripUv, stripIndices, { alpha: 0.9 });

  draw.end();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
