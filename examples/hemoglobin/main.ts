// Every heavy atom of human deoxyhemoglobin (PDB 4HHB) as one shaded ball. Each frame rotates the atoms,
// projects them with perspective, bucket-sorts them back to front and draws them all in a single
// sprites() call with a scale and colour per atom.
import { createRenderer, type Draw } from "spryte";

// atoms.bin: see convert.mjs for the layout.
const data = await (await fetch(new URL("./atoms.bin", import.meta.url))).arrayBuffer();
const N = new DataView(data).getUint32(0, true);
const coords = new Int16Array(data, 4, N * 3);
const element = new Uint8Array(data, 4 + N * 6, N);
const chain = new Uint8Array(data, 4 + N * 7, N);
const haem = new Uint8Array(data, 4 + N * 8, N);

// Van der Waals radii in angstroms, by element code: C, N, O, S, Fe, other.
const RADIUS = [1.7, 1.55, 1.52, 1.8, 2, 1.7];
// Balls at full radius overlap their bonded neighbours, and flat sprites can only be wholly in front or
// behind, so they flicker as the depth order swaps. At this fraction neighbours barely touch.
const BALL_SIZE = 0.4;
// CPK colours, by element code.
const CPK = [0x909090ff, 0x3050f8ff, 0xff0d0dff, 0xffff30ff, 0xe06633ff, 0xff1493ff];
// Chains A and C are the alpha subunits, B and D the beta ones.
const CHAIN = [0x38bdf8ff, 0xf472b6ff, 0xa78bfaff, 0xfbbf24ff];
const HAEM = 0xcffb2dff;
const DIM = 0x343d2aff;
const CAMERA = 160; // eye distance from the centre, in angstroms
const SPAN = 64; // angstroms that fit across the shorter side of the stage at zoom 1
const BUCKETS = 1024;

const MODES = {
  element:
    "Carbon grey, nitrogen blue, oxygen red, sulfur yellow, iron orange: 4,558 atoms, each one sprite, re-sorted by depth every frame.",
  chain:
    "Four chains: two alpha (blue, violet) and two beta (pink, amber). Each one holds a haem group with an iron atom that carries one oxygen molecule.",
  haem: "The four haem groups, where oxygen binds. Each glowing iron sits at the centre of a flat ring, 25 to 40 angstroms from the others.",
} as const;
type Mode = keyof typeof MODES;

const pos = new Float32Array(N * 2);
const scale = new Float32Array(N);
const colors = new Uint32Array(N);
const screen = new Float32Array(N * 2); // projected offsets from the centre, in atom order
const depth = new Float32Array(N);
const bucketOf = new Uint16Array(N);
const start = new Int32Array(BUCKETS + 1);
const order = new Int32Array(N);
// The slab keeps only atoms between two depths, measured across the molecule's bounding sphere so the
// cut stays put in view space while it turns. 0 is the back of the sphere, 1 the front.
let reach = 0;
for (let i = 0; i < N * 3; i += 3) reach = Math.max(reach, Math.hypot(coords[i], coords[i + 1], coords[i + 2]) / 100);
const slab = { back: 0, front: 1 };
let shown = N;
let ironShown = 0;
const iron: number[] = [];
for (let i = 0; i < N; i++) if (element[i] === 4) iron.push(i);
const ironPos = new Float32Array(iron.length * 2);
const ironScale = new Float32Array(iron.length);

// A lit ball and a soft glow, made at runtime so the demo has no assets.
const BALL = 64;
const ball = new OffscreenCanvas(BALL, BALL);
{
  const g = ball.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const r = BALL / 2;
  const fill = g.createRadialGradient(r * 0.7, r * 0.6, r * 0.05, r, r, r);
  fill.addColorStop(0, "#ffffff");
  fill.addColorStop(0.35, "#e4e4e4");
  fill.addColorStop(0.85, "#7a7a7a");
  fill.addColorStop(1, "#3c3c3c");
  g.fillStyle = fill;
  g.beginPath();
  g.arc(r, r, r - 0.5, 0, Math.PI * 2);
  g.fill();
}
const glow = new OffscreenCanvas(BALL, BALL);
{
  const g = glow.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const r = BALL / 2;
  const fill = g.createRadialGradient(r, r, 0, r, r, r);
  fill.addColorStop(0, "rgba(255,190,120,1)");
  fill.addColorStop(0.3, "rgba(255,140,60,0.5)");
  fill.addColorStop(1, "rgba(255,120,40,0)");
  g.fillStyle = fill;
  g.fillRect(0, 0, BALL, BALL);
}

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let mode: Mode = "element";
let yaw = 0.6;
let pitch = -0.25;
let zoom = 1;
let spin = 0.25; // radians per second while nobody is dragging
// Visitors who ask for less motion get a still molecule until they press Play.
let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;
function setPaused(p: boolean): void {
  paused = p;
  pauseButton.textContent = p ? "Play" : "Pause";
  pauseButton.setAttribute("aria-pressed", String(p));
}
pauseButton.addEventListener("click", () => setPaused(!paused));

const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
const caption = document.getElementById("caption") as HTMLDivElement;
let canvas = document.createElement("canvas");
stage.append(canvas);
let draw: Draw = createRenderer(canvas, { backend });

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
function setMode(m: Mode): void {
  mode = m;
  caption.textContent = MODES[m];
  press("modes", "mode", m);
}
document.getElementById("modes")?.addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).dataset.mode as Mode | undefined;
  if (m) setMode(m);
});
addEventListener("keydown", (e) => {
  const m = (Object.keys(MODES) as Mode[])[Number(e.key) - 1];
  if (m) setMode(m);
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

for (const key of ["back", "front"] as const) {
  const input = document.getElementById(key) as HTMLInputElement;
  input.addEventListener("input", () => {
    slab[key] = Number(input.value);
    // The two ends can't cross: dragging one past the other pushes it along.
    const other = key === "back" ? "front" : "back";
    if (slab.back > slab.front) {
      slab[other] = slab[key];
      (document.getElementById(other) as HTMLInputElement).value = String(slab[key]);
    }
  });
}
document.getElementById("whole")?.addEventListener("click", () => {
  slab.back = 0;
  slab.front = 1;
  (document.getElementById("back") as HTMLInputElement).value = "0";
  (document.getElementById("front") as HTMLInputElement).value = "1";
});

// One pointer turns the molecule; two pinch to zoom.
const pointers = new Map<number, { x: number; y: number }>();
let pinch = 0;
stage.addEventListener("pointerdown", (e) => {
  if ((e.target as HTMLElement).closest("#slab")) return; // the sliders, not a drag
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinch = 0;
});
stage.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    yaw += (e.clientX - p.x) * 0.008;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (e.clientY - p.y) * 0.008));
    spin = Math.sign(e.clientX - p.x || spin) * 0.25;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoom = Math.max(0.5, Math.min(4, zoom * (d / pinch)));
    pinch = d;
  }
});
for (const type of ["pointerup", "pointercancel"])
  stage.addEventListener(type, (e) => {
    pointers.delete((e as PointerEvent).pointerId);
    pinch = 0;
  });
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    zoom = Math.max(0.5, Math.min(4, zoom * Math.exp(-e.deltaY * 0.001)));
  },
  { passive: false },
);

function shade(rgba: number, light: number): number {
  const r = ((rgba >>> 24) & 255) * light;
  const g = ((rgba >>> 16) & 255) * light;
  const b = ((rgba >>> 8) & 255) * light;
  return ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/** Rotates, projects and depth-sorts every atom into `pos`, `scale` and `colors`, farthest first. */
function project(w: number, h: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const px = (Math.min(w, h) / SPAN) * zoom; // pixels per angstrom at the centre
  const focal = CAMERA * px;
  let near = -Infinity;
  let far = Infinity;
  for (let i = 0; i < N; i++) {
    const x0 = coords[i * 3] / 100;
    const y0 = coords[i * 3 + 1] / 100;
    const z0 = coords[i * 3 + 2] / 100;
    const x1 = x0 * cy + z0 * sy;
    const z1 = -x0 * sy + z0 * cy;
    const y2 = y0 * cp - z1 * sp;
    const z2 = y0 * sp + z1 * cp; // toward the viewer
    depth[i] = z2;
    if (z2 > near) near = z2;
    if (z2 < far) far = z2;
    const k = focal / (CAMERA - z2);
    screen[i * 2] = x1 * k;
    screen[i * 2 + 1] = -y2 * k;
  }
  // Counting sort on depth: a full comparison sort of 4,558 floats every frame costs more than drawing them.
  const range = near - far || 1;
  start.fill(0);
  for (let i = 0; i < N; i++) {
    const b = Math.min(BUCKETS - 1, ((depth[i] - far) / range) * BUCKETS) | 0;
    bucketOf[i] = b;
    start[b + 1]++;
  }
  for (let b = 1; b <= BUCKETS; b++) start[b] += start[b - 1];
  for (let i = 0; i < N; i++) order[start[bucketOf[i]]++] = i;

  // Fill the draw arrays in sorted order, so later copies (nearer atoms) cover earlier ones.
  const ox = w / 2;
  const oy = h / 2;
  const lo = -reach + slab.back * 2 * reach;
  const hi = -reach + slab.front * 2 * reach;
  let m = 0;
  for (let p = 0; p < N; p++) {
    const i = order[p];
    const z = depth[i];
    if (z < lo || z > hi) continue;
    const q = m++;
    const k = focal / (CAMERA - z);
    pos[q * 2] = ox + screen[i * 2];
    pos[q * 2 + 1] = oy + screen[i * 2 + 1];
    // In haem mode the protein shrinks to a sparse cloud so the buried rings show through.
    const shrink = mode === "haem" && !haem[i] ? 0.35 : 1;
    scale[q] = (RADIUS[element[i]] * BALL_SIZE * 2 * k * shrink) / BALL;
    // Far atoms fade toward the background, so depth reads even when the molecule is still.
    const light = 0.35 + 0.65 * ((z - far) / range);
    const e = element[i];
    let c: number;
    if (mode === "element") c = CPK[e];
    else if (mode === "chain") c = CHAIN[chain[i]];
    else c = haem[i] ? (e === 4 ? CPK[4] : HAEM) : DIM;
    colors[q] = shade(c, light);
  }
  shown = m;
  ironShown = 0;
  for (const i of iron) {
    if (depth[i] < lo || depth[i] > hi) continue;
    const j = ironShown++;
    const k = focal / (CAMERA - depth[i]);
    ironPos[j * 2] = ox + screen[i * 2];
    ironPos[j * 2 + 1] = oy + screen[i * 2 + 1];
    ironScale[j] = (7 * k) / BALL;
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
  if (!paused && pointers.size === 0) yaw += spin * dt;
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
  project(w, h);
  const t1 = performance.now();
  draw.begin("#11140d", w, h, dpr);
  draw.sprites(ball, pos, shown, { smooth: true }, { scale, color: colors });
  if (mode !== "chain") draw.sprites(glow, ironPos, ironShown, { smooth: true, alpha: 0.8 }, { scale: ironScale });
  draw.end();
  const t2 = performance.now();
  simMs += (t1 - t0 - simMs) * 0.05;
  drawMs += (t2 - t1 - drawMs) * 0.05;
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250))
    stats.textContent = `${shown.toLocaleString()} of ${N.toLocaleString()} atoms · ${Math.round(fps)} fps · project and sort ${simMs.toFixed(1)} ms · draw ${drawMs.toFixed(1)} ms · ${draw.kind}`;
  requestAnimationFrame(frame);
}

setPaused(paused);
setMode(mode);
press("backends", "backend", backend);
requestAnimationFrame(frame);
