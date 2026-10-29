// Particles drifting through a flow field, leaving glowing trails. The trails live in a render
// target that is faded a little and drawn over again every frame; the particles are added on top
// with additive blending in one sprites() call; a grain shader finishes the frame on WebGL2.
// The other modes (waves.ts, river.ts, galaxy.ts) simulate and project their own particles and are
// drawn straight to the screen.
import { createRenderer, type Draw, polygon, type RenderTarget, type Shader } from "spryte";
import * as galaxy from "./galaxy.ts";
import { css, PALETTES } from "./palettes.ts";
import * as river from "./river.ts";
import * as waves from "./waves.ts";

const BG = "#11140d";
const FADE = "#11140d26"; // how much of the old frame each new frame covers: lower is longer trails
// Flat mode's colours: it starts with stops 2 and 1, and clicks cycle through the others.
let PALETTE = PALETTES[0].stops;
const MAX = 1_000_000;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const positions = new Float32Array(MAX * 2); // target pixels
const colors = new Uint32Array(MAX);
const life = new Float32Array(MAX); // seconds left before a particle respawns somewhere random
let n = 60_000;
type Mode = "2d" | "galaxy" | "waves" | "river";
const startMode = new URLSearchParams(location.search).get("mode");
let mode: Mode = startMode === "galaxy" || startMode === "waves" || startMode === "river" ? startMode : "2d";

// The 3D modes share one orbiting camera.
const camera = { yaw: 0.6, pitch: 0.75, spin: 0.08 };
let seed = Math.random() * 1000;

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
const caption = document.getElementById("caption") as HTMLDivElement;
const CAPTIONS: Record<Mode, string> = {
  river:
    "A particle fluid in side view: every particle pushes on its neighbours, so water pools, sloshes and piles up. Drag the rocks to dam the river or block the weir. Colour shows speed.",
  waves:
    "An ocean of particles: four Gerstner waves sharpen into crests that throw spray, colour shows height. Click the water to skip a pebble; each touch drives a ripple simulation. Drag to turn the camera.",
  "2d": "Drag to stir the field. Click to drop a colour. Each particle is one copy in a single sprites() call, its trail a render target that fades a little every frame.",
  galaxy:
    "Two spiral galaxies collide. Every star orbits both cores as they swing past each other, tearing the discs into tidal tails. Click for a new encounter; drag to turn the camera.",
};
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
// A crisp 16x16 disc for the fluid, which wants solid drops rather than glow.
const disc = new OffscreenCanvas(16, 16);
{
  const g = disc.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(8, 8, 7.5, 0, Math.PI * 2);
  g.fill();
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
  if (mode === "river") river.grab(x, y);
});
stage.addEventListener("pointermove", (e) => {
  if (!down) return;
  const [x, y] = local(e);
  const dx = x - down.x;
  const dy = y - down.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) down.moved = true;
  if (mode === "river") {
    // The river is side on: dragging moves rocks.
    river.drag(x, y);
    return;
  }
  if (mode !== "2d") {
    // In 3D, dragging turns the camera instead of stirring.
    camera.yaw += dx * 0.004;
    camera.pitch = Math.max(-1.2, Math.min(1.2, camera.pitch + dy * 0.004));
    down.x = x;
    down.y = y;
    return;
  }
  swirls.push({ x, y, dx, dy, age: 0 });
  if (swirls.length > 40) swirls.shift();
  down.x = x;
  down.y = y;
});
stage.addEventListener("pointerup", (e) => {
  river.release();
  if (down && !down.moved && mode === "galaxy") galaxy.reset();
  if (down && !down.moved && mode === "waves") {
    const [x, y] = local(e);
    waves.throwPebble(x, y);
  }
  if (down && !down.moved && mode === "2d") {
    // A click: everything near it takes the next colour.
    const [x, y] = local(e);
    colourIndex = (colourIndex + 1) % 3;
    const drop = PALETTE[[3, 4, 0][colourIndex]];
    const r = 120 * (canvas.width / Math.max(1, stage.clientWidth));
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 2] - x;
      const dy = positions[i * 2 + 1] - y;
      if (dx * dx + dy * dy < r * r) paint(i, drop, 0x34);
    }
  }
  down = null;
});

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
document.getElementById("modes")?.addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).dataset.mode as Mode | undefined;
  if (!m || m === mode) return;
  mode = m;
  trails = null;
  press("modes", "mode", m);
  caption.textContent = CAPTIONS[m];
  applyPalette();
});

// Palettes: each mode remembers its own, so switching modes keeps what you picked for each.
const chosen: Record<Mode, number> = { "2d": 0, galaxy: 3, waves: 1, river: 1 };
const swatches = document.getElementById("palettes") as HTMLElement;
for (const [i, p] of PALETTES.entries()) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "swatch";
  b.dataset.palette = String(i);
  b.setAttribute("aria-label", p.name);
  b.title = p.name;
  b.style.background = css(p.stops);
  swatches.append(b);
}
swatches.addEventListener("click", (e) => {
  const i = (e.target as HTMLElement).dataset.palette;
  if (i === undefined) return;
  chosen[mode] = Number(i);
  applyPalette();
});
function applyPalette(): void {
  const stops = PALETTES[chosen[mode]].stops;
  press("palettes", "palette", String(chosen[mode]));
  if (mode === "2d") {
    PALETTE = stops;
    colourIndex = 1;
    for (let i = 0; i < MAX; i++) paint(i, PALETTE[2 - (i % 2)]);
    trails = null;
  } else if (mode === "galaxy") galaxy.setPalette(stops);
  else if (mode === "waves") waves.setPalette(stops);
  else river.setPalette(stops);
}
document.getElementById("seed")?.addEventListener("click", () => {
  seed = Math.random() * 1000;
  galaxy.reset();
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
    paint(i, PALETTE[2 - (i % 2)]); // two colours to start; clicks bring in the rest
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
let drawMs = 0; // waves mode: time from begin() to end(), the part spryte does
let drawn = 0;
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

  if (mode !== "2d") {
    if (!down) camera.yaw += dt * camera.spin * 0.5;
    const scene = mode === "waves" ? waves : mode === "river" ? river : galaxy;
    // The fluid is far more expensive per particle, so it gets a fifth of the count.
    const count = scene.step(mode === "river" ? Math.round(n / 5) : n, dt, now, W, H, dpr, camera, reducedMotion);
    const d0 = performance.now();
    draw.begin(BG, W / dpr, H / dpr, dpr);
    draw.push();
    draw.scale(1 / dpr);
    if (mode === "river") river.drawScene(draw, (points, color) => polygon(draw, points, color));
    if (mode === "galaxy") {
      // Stars glow where they pile up; dim each one as the count grows so the cores don't go white.
      draw.blend("add");
      draw.sprites(
        dot,
        scene.positions,
        count,
        { alpha: Math.min(1, Math.sqrt(40_000 / count)) },
        { color: scene.colors, scale: scene.scales },
      );
      draw.blend("normal");
    } else draw.sprites(mode === "river" ? disc : dot, scene.positions, count, undefined, { color: scene.colors, scale: scene.scales });
    draw.pop();
    draw.end();
    drawMs += (performance.now() - d0 - drawMs) * 0.05;
    drawn = count;
    work += (performance.now() - t0 - work) * 0.05;
    report(now, dt);
    requestAnimationFrame(frame);
    return;
  }
  step2d(dt, W, H, dpr, now);

  draw.begin(BG, W / dpr, H / dpr, dpr);
  const pts = positions;
  const each = { color: colors };
  draw.into(
    trails,
    () => {
      if (!fresh) draw.rect(0, 0, W, H, FADE);
      draw.blend("add");
      // Additive dots overexpose to white as they pile up, so dim each one as the count grows.
      draw.sprites(dot, pts, n, { alpha: Math.min(1, Math.sqrt(60_000 / n)) }, each);
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
  report(now, dt);
  requestAnimationFrame(frame);
}

// Flat mode's field, sampled on a grid this many CSS pixels apart (see step2d).
const FIELD_CELL = 8;
let fieldX = new Float32Array(0);
let fieldY = new Float32Array(0);

function step2d(dt: number, W: number, H: number, dpr: number, now: number): void {
  // The field: an angle at every point from a few slow, overlapping waves, so it bends and drifts.
  const t = now / 1000 + seed;
  const scale = 0.0022 / dpr;
  const speed = (reducedMotion ? 25 : 60) * dpr;
  for (const s of swirls) s.age += dt;
  while (swirls.length && (swirls[0]?.age ?? 0) > 1.5) swirls.shift();
  const swirlR = 140 * dpr;
  // The field changes slowly across the screen, so work it out (stirring included) on a coarse grid
  // once per frame, and have each particle read it back with a bilinear lookup: a handful of
  // multiplies per particle instead of five trig calls and a loop over every swirl.
  const cell = FIELD_CELL * dpr;
  const gw = Math.ceil(W / cell) + 2;
  const gh = Math.ceil(H / cell) + 2;
  if (fieldX.length < gw * gh) {
    fieldX = new Float32Array(gw * gh);
    fieldY = new Float32Array(gw * gh);
  }
  for (let gy = 0; gy < gh; gy++) {
    const y = gy * cell;
    const sy = y * scale;
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * cell;
      const sx = x * scale;
      const a =
        Math.sin(sx * 1.7 + t * 0.21) * 1.6 + Math.cos(sy * 2.3 - t * 0.17) * 1.6 + Math.sin((sx + sy) * 3.1 + seed + t * 0.11) * 1.2;
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
      fieldX[gy * gw + gx] = vx;
      fieldY[gy * gw + gx] = vy;
    }
  }
  const inv = 1 / cell;
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    let x = positions[j];
    let y = positions[j + 1];
    const fx = x * inv;
    const fy = y * inv;
    const cx = Math.min(gw - 2, Math.max(0, fx | 0));
    const cy = Math.min(gh - 2, Math.max(0, fy | 0));
    const ux = fx - cx;
    const uy = fy - cy;
    const c0 = cy * gw + cx;
    const c1 = c0 + gw;
    const top = fieldX[c0] + (fieldX[c0 + 1] - fieldX[c0]) * ux;
    const bottom = fieldX[c1] + (fieldX[c1 + 1] - fieldX[c1]) * ux;
    const vx = top + (bottom - top) * uy;
    const topY = fieldY[c0] + (fieldY[c0 + 1] - fieldY[c0]) * ux;
    const bottomY = fieldY[c1] + (fieldY[c1 + 1] - fieldY[c1]) * ux;
    const vy = topY + (bottomY - topY) * uy;
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
}

function report(now: number, dt: number): void {
  if (saveNext) {
    saveNext = false;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `spryte-${mode === "2d" ? "flow-field" : mode}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) {
    const sim = mode === "waves" ? waves.timing.sim : mode === "river" ? river.timing.sim : galaxy.timing.sim;
    const split = mode !== "2d" ? ` (simulate ${sim.toFixed(1)}, spryte ${drawMs.toFixed(1)})` : "";
    const count =
      mode === "waves"
        ? `${drawn.toLocaleString()} particles (${waves.side()}² surface + spray)`
        : mode === "river"
          ? `${drawn.toLocaleString()} particles (${river.census()})`
          : mode === "galaxy"
            ? `${drawn.toLocaleString()} stars`
            : `${n.toLocaleString()} particles`;
    stats.textContent = `${count} · ${Math.round(fps)} fps · ${work.toFixed(1)} ms of JS per frame${split} · ${draw.kind} · ${draw.drawCalls} draw calls`;
  }
}

press("backends", "backend", backend);
press("counts", "count", String(n));
press("modes", "mode", mode);
caption.textContent = CAPTIONS[mode];
resize();
for (let i = 0; i < MAX; i++) {
  spawn(i, canvas.width, canvas.height);
  paint(i, PALETTE[2 - (i % 2)]); // two colours to start; clicks bring in the rest
}
applyPalette();
requestAnimationFrame(frame);
