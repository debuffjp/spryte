// Boids (Reynolds' separation, alignment and cohesion) on a uniform grid, so each boid only looks at
// the cells around it. The simulation is plain JavaScript over typed arrays; every boid is one copy in a
// single sprites() call, rotated to its heading and coloured by it.
import { createRenderer, type Draw } from "spryte";

const CAP = 100_000;
const SEE = 28; // neighbour radius in px, and the grid cell size
const MAX_LOOK = 10; // neighbours considered per boid: dense flocks cost the same as sparse ones
const MIN_SPEED = 40;
const MAX_SPEED = 120;
const FEAR = 150; // predator radius in px
const DEFAULTS = { sep: 1.5, ali: 1, coh: 0.8 };

const pos = new Float32Array(CAP * 2);
const vel = new Float32Array(CAP * 2);
const rotations = new Float32Array(CAP);
const colors = new Uint32Array(CAP);
const cellOf = new Int32Array(CAP);
const sorted = new Int32Array(CAP);
let cellStart = new Int32Array(1);
let cols = 1;
let rows = 1;

// Heading to colour: a 64-step wheel through the site's accent colours.
const WHEEL = new Uint32Array(64);
{
  const stops = [0xcffb2d, 0x38bdf8, 0xa78bfa, 0xf472b6, 0xfbbf24, 0xcffb2d];
  for (let k = 0; k < 64; k++) {
    const t = (k / 64) * (stops.length - 1);
    const a = stops[Math.floor(t)];
    const b = stops[Math.floor(t) + 1];
    const f = t - Math.floor(t);
    const mix = (s: number): number => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
    WHEEL[k] = ((mix(16) << 24) | (mix(8) << 16) | (mix(0) << 8) | 0xff) >>> 0;
  }
}

// A small arrowhead pointing right, made at runtime so the demo has no assets.
const arrow = new OffscreenCanvas(8, 6);
{
  const g = arrow.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.beginPath();
  g.moveTo(8, 3);
  g.lineTo(0, 0);
  g.lineTo(2, 3);
  g.lineTo(0, 6);
  g.fill();
}

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let n = innerWidth < 600 ? 2000 : 5000;
const rule = { ...DEFAULTS };
const predator = { x: 0, y: 0, on: false };

const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
let canvas = document.createElement("canvas");
stage.append(canvas);
let draw: Draw = createRenderer(canvas, { backend });

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
function scatter(from: number, to: number): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  for (let i = from; i < to; i++) {
    pos[i * 2] = Math.random() * w;
    pos[i * 2 + 1] = Math.random() * h;
    const a = Math.random() * Math.PI * 2;
    vel[i * 2] = Math.cos(a) * MIN_SPEED;
    vel[i * 2 + 1] = Math.sin(a) * MIN_SPEED;
  }
}

document.getElementById("counts")?.addEventListener("click", (e) => {
  const c = Number((e.target as HTMLElement).dataset.count);
  if (!c) return;
  if (c > n) scatter(n, c);
  n = c;
  press("counts", "count", String(c));
});
document.getElementById("backends")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).dataset.backend as "auto" | "2d" | undefined;
  if (!b || b === backend) return;
  backend = b;
  draw.dispose();
  // A canvas keeps the first context type it gets, so switching renderer means a new canvas.
  const fresh = document.createElement("canvas");
  canvas.replaceWith(fresh);
  canvas = fresh;
  draw = createRenderer(canvas, { backend });
  press("backends", "backend", b);
});
const sliders = { sep: "sep", ali: "ali", coh: "coh" } as const;
for (const key of Object.keys(sliders) as (keyof typeof rule)[]) {
  const input = document.getElementById(key) as HTMLInputElement;
  input.addEventListener("input", () => {
    rule[key] = Number(input.value);
  });
}
document.getElementById("reset")?.addEventListener("click", () => {
  Object.assign(rule, DEFAULTS);
  for (const key of Object.keys(DEFAULTS) as (keyof typeof rule)[])
    (document.getElementById(key) as HTMLInputElement).value = String(DEFAULTS[key]);
});
function aim(e: PointerEvent): void {
  const r = stage.getBoundingClientRect();
  predator.x = e.clientX - r.left;
  predator.y = e.clientY - r.top;
  predator.on = true;
}
stage.addEventListener("pointermove", aim);
stage.addEventListener("pointerdown", aim);
stage.addEventListener("pointerleave", () => {
  predator.on = false;
});

/** Buckets every boid by grid cell with a counting sort, so neighbours sit together in `sorted`. */
function bucket(w: number, h: number): void {
  const c = Math.max(1, Math.ceil(w / SEE));
  const r = Math.max(1, Math.ceil(h / SEE));
  if (c !== cols || r !== rows || cellStart.length !== c * r + 1) {
    cols = c;
    rows = r;
    cellStart = new Int32Array(c * r + 1);
  }
  cellStart.fill(0);
  for (let i = 0; i < n; i++) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(pos[i * 2] / SEE)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(pos[i * 2 + 1] / SEE)));
    const cell = cy * cols + cx;
    cellOf[i] = cell;
    cellStart[cell + 1]++;
  }
  for (let k = 1; k < cellStart.length; k++) cellStart[k] += cellStart[k - 1];
  const fill = cellStart.slice(0, -1);
  for (let i = 0; i < n; i++) sorted[fill[cellOf[i]]++] = i;
}

function step(dt: number, w: number, h: number): void {
  bucket(w, h);
  const see2 = SEE * SEE;
  const fear2 = FEAR * FEAR;
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    const x = pos[j];
    const y = pos[j + 1];
    const cell = cellOf[i];
    const cx = cell % cols;
    const cy = (cell - cx) / cols;
    let seen = 0;
    let sx = 0;
    let sy = 0;
    let ax = 0;
    let ay = 0;
    let mx = 0;
    let my = 0;
    // Start the scan at a different neighbour cell per boid, so the MAX_LOOK cap doesn't always favour
    // the top-left cell and skew the whole flock in one direction.
    const first = i % 9;
    for (let s = 0; s < 9 && seen < MAX_LOOK; s++) {
      const k = (first + s) % 9;
      const nx = cx + (k % 3) - 1;
      const ny = cy + ((k / 3) | 0) - 1;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const c = ny * cols + nx;
      for (let q = cellStart[c]; q < cellStart[c + 1] && seen < MAX_LOOK; q++) {
        const o = sorted[q];
        if (o === i) continue;
        const dx = pos[o * 2] - x;
        const dy = pos[o * 2 + 1] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 > see2 || d2 === 0) continue;
        seen++;
        // Separation only up close (inside a third of the view), so boids keep a spacing instead of
        // pushing every neighbour away.
        if (d2 < see2 / 9) {
          sx -= dx / d2;
          sy -= dy / d2;
        }
        ax += vel[o * 2];
        ay += vel[o * 2 + 1];
        mx += dx;
        my += dy;
      }
    }
    let vx = vel[j];
    let vy = vel[j + 1];
    if (seen) {
      vx += (sx * 900 * rule.sep + (ax / seen - vx) * rule.ali + (mx / seen) * rule.coh * 4) * dt * 2;
      vy += (sy * 900 * rule.sep + (ay / seen - vy) * rule.ali + (my / seen) * rule.coh * 4) * dt * 2;
    }
    if (predator.on) {
      const dx = x - predator.x;
      const dy = y - predator.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < fear2) {
        const push = (1 - d2 / fear2) * 1800 * dt;
        const d = Math.sqrt(d2) || 1;
        vx += (dx / d) * push;
        vy += (dy / d) * push;
      }
    }
    const sp = Math.sqrt(vx * vx + vy * vy) || 1;
    const clamp = sp > MAX_SPEED ? MAX_SPEED / sp : sp < MIN_SPEED ? MIN_SPEED / sp : 1;
    vx *= clamp;
    vy *= clamp;
    vel[j] = vx;
    vel[j + 1] = vy;
    // Wrap at the edges so the flock never piles up against a wall.
    let nx = x + vx * dt;
    let ny = y + vy * dt;
    if (nx < 0) nx += w;
    else if (nx >= w) nx -= w;
    if (ny < 0) ny += h;
    else if (ny >= h) ny -= h;
    pos[j] = nx;
    pos[j + 1] = ny;
    const heading = Math.atan2(vy, vx);
    rotations[i] = heading;
    colors[i] = WHEEL[((heading / (Math.PI * 2) + 1) * 64) & 63];
  }
}

let last = 0;
let fps = 60;
let simMs = 0;
let drawMs = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    draw.resize(pw, ph);
  }
  const t0 = performance.now();
  step(dt, w, h);
  const t1 = performance.now();
  draw.begin("#11140d", w, h, dpr);
  draw.sprites(arrow, pos, n, { scale: 0.8 }, { rotation: rotations, color: colors });
  if (predator.on) draw.rect(predator.x - 3, predator.y - 3, 6, 6, "#ffffff");
  draw.end();
  const t2 = performance.now();
  simMs += (t1 - t0 - simMs) * 0.05;
  drawMs += (t2 - t1 - drawMs) * 0.05;
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250))
    stats.textContent = `${n.toLocaleString()} boids · ${Math.round(fps)} fps · simulate ${simMs.toFixed(1)} ms · draw ${drawMs.toFixed(1)} ms · ${draw.kind}`;
  requestAnimationFrame(frame);
}

press("counts", "count", String(n));
press("backends", "backend", backend);
requestAnimationFrame(() => {
  scatter(0, CAP);
  requestAnimationFrame(frame);
});
