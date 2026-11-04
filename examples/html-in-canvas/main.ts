// drawElement(): live DOM (a form with a text field) drawn by spryte inside a low-resolution game view.
// Needs the HTML-in-Canvas API: Chrome or Edge 157 and later.
// ?backend=2d forces the Canvas 2D fallback.
import { createRenderer, drawElement } from "spryte";

const canvas = document.querySelector("canvas") as HTMLCanvasElement;
const panel = document.getElementById("panel") as HTMLFormElement;
const note = document.getElementById("note") as HTMLElement;
const backend = new URLSearchParams(location.search).get("backend") === "2d" ? "2d" : "auto";
const draw = createRenderer(canvas, { backend });

// The game's view is 320x180 logical units, scaled to fill the window.
const W = 320;
const H = 180;
let message = "";
panel.addEventListener("submit", (e) => {
  e.preventDefault();
  message = `Hello, ${(document.getElementById("name") as HTMLInputElement).value || "nobody"}!`;
});
document.getElementById("quit")?.addEventListener("click", () => {
  message = "Quit clicked";
});

const dot = new OffscreenCanvas(8, 8);
const g = dot.getContext("2d") as OffscreenCanvasRenderingContext2D;
g.fillStyle = "#fff";
g.fillRect(2, 0, 4, 8);
g.fillRect(0, 2, 8, 4);

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;
let drawn = false;
// Median CPU time of drawElement() over the last 60 frames, shown in the note.
const costs: number[] = [];
function frame(ms: number): void {
  const dpr = devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr);
  const ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    draw.resize(cw, ch);
  }
  const scale = Math.min(cw / W, ch / H);
  const t = ms / 1000;
  draw.begin("#111", cw / scale, ch / scale, scale);
  draw.rect(0, 0, W, H, "#16213a");
  // Sprites behind the panel...
  for (let i = 0; i < 40; i++) draw.sprite(dot, (i * 37 + t * 20) % W, 20 + ((i * 53) % 140), { tint: "#4b6cb7" });
  // ...the panel, tilted a little to show it follows the transform (and still takes clicks)...
  draw.push();
  draw.translate(100, 40);
  draw.rotate(Math.sin(t) * 0.05);
  const start = performance.now();
  drawn = drawElement(draw, panel, 0, 0);
  costs.push(performance.now() - start);
  if (costs.length > 60) costs.shift();
  draw.pop();
  // ...and sprites in front of it.
  draw.sprite(dot, 100 + ((t * 30) % 140), 30, { tint: "#cffb2d", scaleX: 2, scaleY: 2 });
  draw.text(message, 8, 8, { font: "10px sans-serif", color: "#cffb2d" });
  draw.end();
  note.textContent = drawn
    ? `${draw.kind}: the form is drawn by spryte, drawElement ${median(costs).toFixed(2)} ms`
    : `${draw.kind}: HTML-in-Canvas unavailable, so the form isn't drawn`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
