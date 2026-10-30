// Confetti over a normal HTML page. The canvas is fixed over everything with pointer-events: none,
// cleared to transparent each frame, and every live piece is one copy in a single sprites() call.
import { createRenderer, type Draw } from "spryte";

const CAP = 200_000;
const COLORS = [0xcffb2d, 0x38bdf8, 0xf472b6, 0xfbbf24, 0xa78bfa, 0xffffff];
const GRAVITY = 900; // px/s²
const DRAG = 1.6; // per second, so pieces float instead of dropping like stones

// Pieces live in a ring: a new burst overwrites the oldest pieces once the pool is full.
const pos = new Float32Array(CAP * 2);
const vel = new Float32Array(CAP * 2);
const angle = new Float32Array(CAP);
const spin = new Float32Array(CAP);
const phase = new Float32Array(CAP);
const base = new Uint32Array(CAP);
const colors = new Uint32Array(CAP);
const scales = new Float32Array(CAP);
let next = 0;
let live = 0;

// A 4x8 strip, made at runtime so the demo has no assets.
const strip = new OffscreenCanvas(4, 8);
{
  const g = strip.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 4, 8);
}

const canvas = document.getElementById("confetti") as HTMLCanvasElement;
const stats = document.getElementById("stats") as HTMLSpanElement;
const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let size = 2000;
let current = canvas;
let draw: Draw = createRenderer(current, { backend, transparent: true });

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}

/** Throws `count` pieces from (x, y), aimed at `dir` radians with `spread` either side. */
function burst(x: number, y: number, count: number, dir: number, spread: number, speed: number): void {
  for (let k = 0; k < count; k++) {
    const i = next;
    next = (next + 1) % CAP;
    const a = dir + (Math.random() - 0.5) * 2 * spread;
    const s = speed * (0.35 + Math.random() * 0.65);
    pos[i * 2] = x;
    pos[i * 2 + 1] = y;
    vel[i * 2] = Math.cos(a) * s;
    vel[i * 2 + 1] = Math.sin(a) * s;
    angle[i] = Math.random() * Math.PI * 2;
    spin[i] = (Math.random() - 0.5) * 18;
    phase[i] = Math.random() * Math.PI * 2;
    base[i] = COLORS[(Math.random() * COLORS.length) | 0];
  }
  live = Math.min(CAP, live + count);
}

function fromElement(el: Element, count: number): void {
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, count, -Math.PI / 2, 1.1, 1700);
}

document.getElementById("pop")?.addEventListener("click", (e) => {
  e.stopPropagation();
  fromElement(e.currentTarget as Element, size);
});
document.getElementById("rain")?.addEventListener("click", (e) => {
  e.stopPropagation();
  // A curtain from above the top edge, falling straight down.
  const n = size;
  for (let k = 0; k < 40; k++) burst(Math.random() * innerWidth, -20, Math.ceil(n / 40), Math.PI / 2, 0.4, 300);
});
document.getElementById("form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  fromElement(e.currentTarget as Element, Math.ceil(size / 4));
});
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("button, a, input, header")) return;
  if (getSelection()?.toString()) return; // finishing a text selection isn't a request for confetti
  burst(e.clientX, e.clientY, Math.ceil(size / 4), -Math.PI / 2, Math.PI, 900);
});
document.getElementById("sizes")?.addEventListener("click", (e) => {
  const s = Number((e.target as HTMLElement).dataset.size);
  if (!s) return;
  size = s;
  press("sizes", "size", String(s));
});
document.getElementById("backends")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).dataset.backend as "auto" | "2d" | undefined;
  if (!b || b === backend) return;
  backend = b;
  draw.dispose();
  // A canvas keeps the first context type it gets, so switching renderer means a new canvas.
  const fresh = current.cloneNode() as HTMLCanvasElement;
  current.replaceWith(fresh);
  current = fresh;
  draw = createRenderer(current, { backend, transparent: true });
  press("backends", "backend", b);
});

let last = 0;
let fps = 60;
let work = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const t0 = performance.now();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = innerWidth;
  const h = innerHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (current.width !== pw || current.height !== ph) {
    current.width = pw;
    current.height = ph;
    draw.resize(pw, ph);
  }

  // Pieces flutter: a strip facing you falls slowly and looks bright, one edge-on drops faster and
  // looks darker. The facing comes from a per-piece phase, since sprites() scale is uniform.
  const drag = Math.exp(-DRAG * dt);
  let alive = 0;
  for (let i = 0; i < live; i++) {
    const j = i * 2;
    let y = pos[j + 1];
    if (y > h + 40) {
      scales[i] = 0;
      colors[i] = 0;
      continue;
    }
    alive++;
    phase[i] += dt * (4 + (i % 7));
    const face = Math.abs(Math.cos(phase[i]));
    vel[j] = vel[j] * drag + Math.sin(phase[i] * 0.5) * 30 * dt;
    vel[j + 1] = vel[j + 1] * drag + GRAVITY * dt * (0.25 + 0.75 * (1 - face));
    pos[j] += vel[j] * dt;
    y += vel[j + 1] * dt;
    pos[j + 1] = y;
    angle[i] += spin[i] * dt;
    scales[i] = 0.7 + face * 0.6;
    const shade = 0.55 + face * 0.45;
    const c = base[i];
    const r = ((c >> 16) & 255) * shade;
    const g = ((c >> 8) & 255) * shade;
    const b = (c & 255) * shade;
    colors[i] = ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
  }
  if (!alive) live = 0; // everything has landed: the next burst starts from an empty pool

  draw.begin("#00000000", w, h, dpr); // transparent, so the page shows through
  if (live) draw.sprites(strip, pos, live, undefined, { rotation: angle, scale: scales, color: colors });
  draw.end();
  work += (performance.now() - t0 - work) * 0.05;
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250))
    stats.textContent = `${alive.toLocaleString()} pieces · ${Math.round(fps)} fps · ${work.toFixed(1)} ms of JS · ${draw.kind}`;
  requestAnimationFrame(frame);
}

press("sizes", "size", String(size));
press("backends", "backend", backend);
setTimeout(() => fromElement(document.getElementById("pop") as Element, size), 400);
requestAnimationFrame(frame);
