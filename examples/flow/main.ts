// Particles drifting through a flow field, leaving glowing trails. The trails live in a render
// target that is faded a little and drawn over again every frame; the particles are added on top
// with additive blending in one sprites() call; a grain shader finishes the frame on WebGL2.
import { createRenderer, type Draw, type RenderTarget, type Shader } from "spryte";

const BG = "#11140d";
const FADE = "#11140d26"; // how much of the old frame each new frame covers: lower is longer trails
// The colours of debuff.jp's spryte page.
const PALETTE = [0xcffb2d, 0x38bdf8, 0xf472b6, 0xfbbf24, 0xa78bfa];
const MAX = 150_000;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const positions = new Float32Array(MAX * 2); // target pixels
const colors = new Uint32Array(MAX);
const life = new Float32Array(MAX); // seconds left before a particle respawns somewhere random
let n = 60_000;
let seed = Math.random() * 1000;

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
let canvas = document.createElement("canvas");
let draw: Draw;
let trails: RenderTarget | null = null;
let grain: Shader | null = null;

function makeRenderer(): void {
  // A canvas keeps the first context type it gets, so switching renderer means a new canvas.
  const next = document.createElement("canvas");
  canvas.replaceWith(next);
  if (!next.isConnected) stage.append(next);
  canvas = next;
  draw = createRenderer(canvas, { backend });
  trails = null;
  grain =
    draw.kind === "webgl2"
      ? draw.createShader(`
          uniform float seed;
          vec4 effect(vec4 color, vec2 uv) {
            vec4 c = source(uv) * color;
            float n = fract(sin(dot(uv * 913.0 + seed, vec2(12.9898, 78.233))) * 43758.5453);
            c.rgb += (n - 0.5) * 0.06 * c.a;
            return c;
          }
        `)
      : null;
}
makeRenderer();

// A 5x5 soft dot made at runtime, so the example has no assets.
const dot = new OffscreenCanvas(5, 5);
{
  const g = dot.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const grad = g.createRadialGradient(2.5, 2.5, 0, 2.5, 2.5, 2.5);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(1, "#fff0");
  g.fillStyle = grad;
  g.fillRect(0, 0, 5, 5);
}

function spawn(i: number, w: number, h: number): void {
  positions[i * 2] = Math.random() * w;
  positions[i * 2 + 1] = Math.random() * h;
  life[i] = 2 + Math.random() * 6;
}
function paint(i: number, c: number, alpha = 0x1c): void {
  colors[i] = ((c << 8) | alpha) >>> 0;
}

// Stirring: each drag sample leaves a small vortex that fades out.
const swirls: { x: number; y: number; dx: number; dy: number; age: number }[] = [];
let down: { x: number; y: number; moved: boolean } | null = null;
let colourIndex = 1;
function local(e: PointerEvent): [number, number] {
  const r = stage.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, r.width);
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
}
stage.addEventListener("pointerdown", (e) => {
  stage.setPointerCapture(e.pointerId);
  const [x, y] = local(e);
  down = { x, y, moved: false };
});
stage.addEventListener("pointermove", (e) => {
  if (!down) return;
  const [x, y] = local(e);
  const dx = x - down.x;
  const dy = y - down.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
  swirls.push({ x, y, dx, dy, age: 0 });
  if (swirls.length > 40) swirls.shift();
  down.x = x;
  down.y = y;
});
stage.addEventListener("pointerup", (e) => {
  if (down && !down.moved) {
    // A click: everything near it takes the next colour.
    const [x, y] = local(e);
    colourIndex = 2 + ((colourIndex - 1) % (PALETTE.length - 2));
    const r = 120 * (canvas.width / Math.max(1, stage.clientWidth));
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 2] - x;
      const dy = positions[i * 2 + 1] - y;
      if (dx * dx + dy * dy < r * r) paint(i, PALETTE[colourIndex], 0x34);
    }
  }
  down = null;
});

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
document.getElementById("seed")?.addEventListener("click", () => {
  seed = Math.random() * 1000;
  trails = null; // start from a clean canvas
});
let saveNext = false;
document.getElementById("save")?.addEventListener("click", () => {
  saveNext = true;
});
document.getElementById("backends")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).dataset.backend as "auto" | "2d" | undefined;
  if (!b || b === backend) return;
  backend = b;
  draw.dispose();
  makeRenderer();
  press("backends", "backend", b);
});
document.getElementById("counts")?.addEventListener("click", (e) => {
  const c = Number((e.target as HTMLElement).dataset.count);
  if (!c) return;
  for (let i = n; i < c; i++) {
    spawn(i, canvas.width, canvas.height);
    paint(i, PALETTE[i % 2]); // lime and sky to start; clicks bring in the rest
  }
  n = c;
  press("counts", "count", String(c));
});

function resize(): number {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(stage.clientWidth * dpr);
  const h = Math.round(stage.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    draw.resize(w, h);
    trails = null;
  }
  return dpr;
}

let last = 0;
let fps = 60;
let work = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const t0 = performance.now();
  const dpr = resize();
  const W = canvas.width;
  const H = canvas.height;
  let fresh = false;
  if (!trails || trails.width !== W || trails.height !== H) {
    if (trails) draw.disposeTarget(trails);
    trails = draw.createTarget(W, H);
    fresh = true;
  }

  // The field: an angle at every point from a few slow, overlapping waves, so it bends and drifts.
  const t = now / 1000 + seed;
  const scale = 0.0022 / dpr;
  const speed = (reducedMotion ? 25 : 60) * dpr;
  for (const s of swirls) s.age += dt;
  while (swirls.length && (swirls[0]?.age ?? 0) > 1.5) swirls.shift();
  const swirlR = 140 * dpr;
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    let x = positions[j];
    let y = positions[j + 1];
    const sx = x * scale;
    const sy = y * scale;
    const a = Math.sin(sx * 1.7 + t * 0.21) * 1.6 + Math.cos(sy * 2.3 - t * 0.17) * 1.6 + Math.sin((sx + sy) * 3.1 + seed + t * 0.11) * 1.2;
    let vx = Math.cos(a) * speed;
    let vy = Math.sin(a) * speed;
    for (const s of swirls) {
      const dx = x - s.x;
      const dy = y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < swirlR * swirlR) {
        const f = (1 - d2 / (swirlR * swirlR)) * (1 - s.age / 1.5);
        vx += (s.dx * 18 - dy * 2) * f;
        vy += (s.dy * 18 + dx * 2) * f;
      }
    }
    x += vx * dt;
    y += vy * dt;
    life[i] -= dt;
    if (life[i] <= 0 || x < 0 || y < 0 || x > W || y > H) {
      spawn(i, W, H);
    } else {
      positions[j] = x;
      positions[j + 1] = y;
    }
  }

  draw.begin(BG, W / dpr, H / dpr, dpr);
  draw.into(
    trails,
    () => {
      if (!fresh) draw.rect(0, 0, W, H, FADE);
      draw.blend("add");
      draw.sprites(dot, positions, n, undefined, { color: colors });
      draw.blend("normal");
    },
    fresh ? BG : null,
  );
  const show = (): void => draw.sprite(trails as RenderTarget, 0, 0, { origin: [0, 0], scaleX: 1 / dpr, scaleY: 1 / dpr });
  if (grain) {
    grain.set("seed", (now / 1000) % 1);
    draw.withShader(grain, show);
  } else show();
  draw.end();
  work += (performance.now() - t0 - work) * 0.05;

  if (saveNext) {
    saveNext = false;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "spryte-flow-field.png";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) {
    stats.textContent = `${n.toLocaleString()} particles · ${Math.round(fps)} fps · ${work.toFixed(1)} ms of JS per frame · ${draw.kind} · ${draw.drawCalls} draw calls`;
  }
  requestAnimationFrame(frame);
}

press("backends", "backend", backend);
press("counts", "count", String(n));
resize();
for (let i = 0; i < MAX; i++) {
  spawn(i, canvas.width, canvas.height);
  paint(i, PALETTE[i % 2]); // lime and sky to start; clicks bring in the rest
}
requestAnimationFrame(frame);
