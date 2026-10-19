// spryte on its own: no game framework, just a canvas, a renderer and a frame loop.
import { createRenderer } from "spryte";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const draw = createRenderer(canvas);

// A 16x16 sprite made at runtime, so the example has no assets.
const dot = new OffscreenCanvas(16, 16);
const g = dot.getContext("2d") as OffscreenCanvasRenderingContext2D;
g.fillStyle = "#fff";
g.fillRect(4, 0, 8, 16);
g.fillRect(0, 4, 16, 8);

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
  for (let i = 0; i < 500; i++) {
    const a = i * 0.37 + t * 0.5;
    const r = 20 + (i % 50) * 4;
    draw.sprite(dot, w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, {
      rotation: a,
      tint: i % 3 ? "#cffb2d" : "#ffffff",
      alpha: 0.8,
    });
  }
  draw.text(`${draw.kind} · ${draw.drawCalls} draw calls`, 8, 8, { font: "14px sans-serif" });
  draw.end();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Tear down with draw.dispose() when the canvas goes away.
