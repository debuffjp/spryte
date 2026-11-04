// An E. coli ribosome (PDB 7N1P), every heavy atom one sprite, running a schematic elongation cycle: a
// tRNA arrives in the A site, the chain moves onto it, both tRNAs step to the P and E sites as the mRNA
// moves one codon, and the empty tRNA leaves. The ribosome is the real structure; the motion is
// keyframed, with each tRNA a rigid copy of the P-site one. Each frame rotates, projects and
// bucket-sorts about 150,000 atoms and draws them in a single sprites() call.
import { createRenderer, type Draw } from "spryte";

// atoms.dat: see convert.mjs for the layout. It's gzipped; the browser unpacks it as it downloads.
const packed = (await fetch(new URL("./atoms.dat", import.meta.url))).body as ReadableStream<Uint8Array<ArrayBuffer>>;
const data = await new Response(packed.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
const N = new DataView(data).getUint32(0, true);
const marks = new Float32Array(data, 4, 15);
// Coordinates in angstroms, x, y, z per atom, rebuilt from the differences in the file.
const coords = new Float32Array(N * 3);
{
  const bytes = new Uint8Array(data, 64, N * 6);
  for (let k = 0; k < 3; k++) {
    let v = 0;
    for (let i = 0; i < N; i++) {
      v += ((bytes[k * N + i] | (bytes[3 * N + k * N + i] << 8)) << 16) >> 16;
      coords[i * 3 + k] = v / 10;
    }
  }
}
const element = new Uint8Array(data, 64 + N * 6, N);
const group = new Uint8Array(data, 64 + N * 7, N);
type Vec = [number, number, number];
// amino.json: see convert.mjs. Each amino acid's atoms in its own frame, and the sequence the demo builds.
const amino: { templates: Record<string, number[][]>; sequence: string[] } = await (
  await fetch(new URL("./amino.json", import.meta.url))
).json();
const SEQUENCE = amino.sequence;
const LONGEST = Math.max(...Object.values(amino.templates).map((t) => t.length));
const mark = (k: number): Vec => [marks[k * 3], marks[k * 3 + 1], marks[k * 3 + 2]];
const SITE_A = mark(0);
const SITE_P = mark(1);
const PTC = mark(2);
const EXIT = mark(3);
const CODON = mark(4); // one codon step along the mRNA, from the A site toward the P site
// The E site isn't in this entry: put it one more step past the P site, as far as A is from P.
const SITE_E: Vec = [0, 1, 2].map((k) => 2 * SITE_P[k] - SITE_A[k]) as Vec;
const unit = (v: Vec): Vec => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const IN = unit(SITE_A); // tRNAs arrive from outside along the line through the A site
const OUT = unit(SITE_E); // and leave along the line through the E site
const TUNNEL_OUT = unit(EXIT);

const MRNA = 5;
const TRNA = 6;
const template: number[] = [];
const mrna: number[] = [];
const still: number[] = [];
for (let i = 0; i < N; i++) (group[i] === TRNA ? template : group[i] === MRNA ? mrna : still).push(i);
let builtFor = ""; // the colouring the still atoms were last built for

// Van der Waals radii in angstroms, by element code: C, N, O, P, S, other.
const RADIUS = [1.7, 1.55, 1.52, 1.8, 1.8, 1.7];
// Balls at full radius overlap their bonded neighbours, and flat sprites can only be wholly in front or
// behind, so they flicker as the depth order swaps. At this fraction neighbours barely touch.
const BALL_SIZE = 0.4;
const RISE = 3.6; // angstroms between amino acids along an extended chain
const CPK = [0x909090ff, 0x3050f8ff, 0xff0d0dff, 0xff8000ff, 0xffff30ff, 0xff1493ff];
// By group: 23S rRNA, 5S rRNA, 16S rRNA, large-subunit protein, small-subunit protein, mRNA.
const SUBUNIT = [0x8fa3b8ff, 0x8fa3b8ff, 0xd9b8ccff, 0x4b6a8aff, 0x9b5f80ff, 0xcffb2dff];
const FAINT = [0x4a6278ff, 0x4a6278ff, 0x7a5568ff, 0x4a6278ff, 0x7a5568ff, 0xcffb2dff];
// Each tRNA, and the amino acid it brings, gets the next colour.
const TRNA_COLORS = [0xa78bfaff, 0xfbbf24ff, 0x38bdf8ff, 0xf472b6ff];
const CAMERA = 700; // eye distance from the centre, in angstroms
const SPAN = 280; // angstroms that fit across the shorter side of the stage at zoom 1
const BUCKETS = 4096;
const CYCLE = 5; // seconds per codon

const MODES = {
  translation:
    "The ribosome reads the mRNA (lime) one codon at a time. Each tRNA brings one amino acid, atom by atom, hands the chain on and leaves. The chain, ribosomal protein L23 in this demo, grows out through the exit tunnel.",
  subunits:
    "The large subunit (blue) and small subunit (pink), rRNA lighter and proteins darker. Nearly two thirds of the mass is RNA. Pull the slab together to cut through to the tRNAs.",
  element: `Carbon grey, nitrogen blue, oxygen red, phosphorus orange: ${N.toLocaleString()} atoms from the real structure, each one sprite, re-sorted by depth every frame.`,
} as const;
type Mode = keyof typeof MODES;

// The atoms drawn this frame, in world space: the ribosome, the moving mRNA, three tRNAs and the chain.
const CAP = N + template.length * 2 + SEQUENCE.length * LONGEST;
const wx = new Float32Array(CAP);
const wy = new Float32Array(CAP);
const wz = new Float32Array(CAP);
const wr = new Float32Array(CAP); // radius in angstroms
const wc = new Uint32Array(CAP); // colour before depth shading
let count = 0;

const screen = new Float32Array(CAP * 2);
const depth = new Float32Array(CAP);
const bucketOf = new Uint16Array(CAP);
const start = new Int32Array(BUCKETS + 1);
const order = new Int32Array(CAP);
const pos = new Float32Array(CAP * 2);
const scale = new Float32Array(CAP);
const colors = new Uint32Array(CAP);

let reach = 0;
for (let i = 0; i < N * 3; i += 3) reach = Math.max(reach, Math.hypot(coords[i], coords[i + 1], coords[i + 2]));
const slab = { back: 0, front: 1 };
let shown = 0;

// The chain's path: from the peptidyl transferase centre straight down the tunnel to its exit, then
// out into the cell, where it winds into a loose ball beside the exit.
const TUNNEL = Math.hypot(EXIT[0] - PTC[0], EXIT[1] - PTC[1], EXIT[2] - PTC[2]);
const SIDE = unit([TUNNEL_OUT[1], -TUNNEL_OUT[0], 0]);
const SIDE2: Vec = [
  TUNNEL_OUT[1] * SIDE[2] - TUNNEL_OUT[2] * SIDE[1],
  TUNNEL_OUT[2] * SIDE[0] - TUNNEL_OUT[0] * SIDE[2],
  TUNNEL_OUT[0] * SIDE[1] - TUNNEL_OUT[1] * SIDE[0],
];
function along(s: number, out: Vec): void {
  if (s <= TUNNEL) {
    for (let k = 0; k < 3; k++) out[k] = PTC[k] + ((EXIT[k] - PTC[k]) * s) / TUNNEL;
    return;
  }
  // A spiral that widens and drifts away from the exit, with a wobble so it reads as a fold.
  const d = s - TUNNEL;
  const turn = d * 0.08;
  const r = Math.min(14, d * 0.3) + 4 * Math.sin(d * 0.21);
  const rise = 3 + d * 0.12;
  for (let k = 0; k < 3; k++) out[k] = EXIT[k] + TUNNEL_OUT[k] * rise + (SIDE[k] * Math.cos(turn) + SIDE2[k] * Math.sin(turn)) * r;
}

// A lit ball, made at runtime so the demo has no assets.
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

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let mode: Mode = "translation";
let yaw = 2.2;
let pitch = -0.3;
let zoom = 1;
let spin = 0.08; // radians per second while nobody is dragging
let clock = Number(params.get("t")) || 0; // seconds of translation so far; ?t= starts later
// Visitors who ask for less motion get a still ribosome until they press Play.
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

function press(groupId: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${groupId} button`))
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

// One pointer turns the ribosome; two pinch to zoom.
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
    spin = Math.sign(e.clientX - p.x || spin) * 0.08;
  }
  p.x = e.clientX;
  p.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoom = Math.max(0.5, Math.min(6, zoom * (d / pinch)));
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
    zoom = Math.max(0.5, Math.min(6, zoom * Math.exp(-e.deltaY * 0.001)));
  },
  { passive: false },
);

function shade(rgba: number, light: number): number {
  const r = ((rgba >>> 24) & 255) * light;
  const g = ((rgba >>> 16) & 255) * light;
  const b = ((rgba >>> 8) & 255) * light;
  return ((r << 24) | (g << 16) | (b << 8) | (rgba & 255)) >>> 0;
}
const ease = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};
const lerp = (a: Vec, b: Vec, t: number, out: Vec): Vec => {
  for (let k = 0; k < 3; k++) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
};

/** Adds one tRNA, the P-site atoms moved to `at`, with an alpha from 0 to 1. */
function addTrna(at: Vec, id: number, alpha: number): void {
  if (alpha <= 0) return;
  const dx = at[0] - SITE_P[0];
  const dy = at[1] - SITE_P[1];
  const dz = at[2] - SITE_P[2];
  const tint = TRNA_COLORS[id % TRNA_COLORS.length];
  const a = Math.round(alpha * 255);
  for (const i of template) {
    wx[count] = coords[i * 3] + dx;
    wy[count] = coords[i * 3 + 1] + dy;
    wz[count] = coords[i * 3 + 2] + dz;
    wr[count] = RADIUS[element[i]] * BALL_SIZE;
    wc[count] = (((mode === "element" ? CPK[element[i]] : tint) & ~255) | a) >>> 0;
    count++;
  }
}

/** Fills the world arrays for the moment `t` seconds into translation. */
function build(t: number): void {
  const cycle = Math.floor(t / CYCLE);
  const u = t - cycle * CYCLE;
  const leave = ease(u / 1); // 0-1 s: the empty tRNA leaves the E site
  const arrive = ease((u - 0.6) / 1.4); // 0.6-2 s: a new tRNA arrives in the A site
  const transfer = ease((u - 2) / 0.6); // 2-2.6 s: the chain moves onto it and grows by one
  const move = ease((u - 2.6) / 1.4); // 2.6-4 s: translocation, one codon along

  // The ribosome itself never moves: its atoms fill the front of the world arrays once, and again only
  // when the colouring changes. Every frame rewrites just what moves after them.
  if (builtFor !== mode) {
    builtFor = mode;
    for (let q = 0; q < still.length; q++) {
      const i = still[q];
      wx[q] = coords[i * 3];
      wy[q] = coords[i * 3 + 1];
      wz[q] = coords[i * 3 + 2];
      // In the translation view the ribosome shrinks to a faint cloud so the tRNAs and mRNA show through.
      const faint = mode === "translation";
      wr[q] = RADIUS[element[i]] * BALL_SIZE * (faint ? 0.6 : 1);
      wc[q] = mode === "element" ? CPK[element[i]] : faint ? FAINT[group[i]] : SUBUNIT[group[i]];
    }
  }
  count = still.length;
  const shift: Vec = [CODON[0] * move, CODON[1] * move, CODON[2] * move];
  for (const i of mrna) {
    wx[count] = coords[i * 3] + shift[0];
    wy[count] = coords[i * 3 + 1] + shift[1];
    wz[count] = coords[i * 3 + 2] + shift[2];
    wr[count] = RADIUS[element[i]] * BALL_SIZE;
    wc[count] = mode === "element" ? CPK[element[i]] : SUBUNIT[MRNA];
    count++;
  }

  // tRNA `cycle - 1` leaves from E, `cycle` steps from P to E, `cycle + 1` arrives in A and steps to P.
  const at: Vec = [0, 0, 0];
  const from: Vec = [0, 0, 0];
  for (let k = 0; k < 3; k++) at[k] = SITE_E[k] + OUT[k] * 160 * leave;
  addTrna(at, cycle - 1, 1 - leave);
  addTrna(lerp(SITE_P, SITE_E, move, at), cycle, 1);
  for (let k = 0; k < 3; k++) from[k] = SITE_A[k] + IN[k] * 160 * (1 - arrive);
  addTrna(lerp(from, SITE_P, move, at), cycle + 1, arrive);

  // The chain: amino acid j came with tRNA j. The incoming one rides on its tRNA's CCA end; during the
  // transfer it joins the chain at the PTC and pushes the rest one step along the tunnel.
  const p: Vec = [0, 0, 0];
  const q: Vec = [0, 0, 0];
  const end: Vec = [0, 0, 0];
  for (let j = Math.min(cycle + 1, SEQUENCE.length - 1); j >= 0; j--) {
    const s = (cycle + transfer - j) * RISE;
    along(Math.max(0, s), p);
    let alpha = 1;
    if (j === cycle + 1) {
      // Still on its tRNA: the CCA end sits as far from the PTC as the tRNA is from the P site.
      for (let k = 0; k < 3; k++) end[k] = PTC[k] + from[k] - SITE_P[k];
      lerp(end, p, transfer, p);
      alpha = arrive;
    }
    along(Math.max(0, s) + 1, q);
    addResidue(j, p, q, alpha);
  }
}

/** Adds amino acid `j` of the sequence at `p`, its backbone running toward `ahead`. */
function addResidue(j: number, p: Vec, ahead: Vec, alpha: number): void {
  if (alpha <= 0) return;
  // The residue's frame: x along the chain, y to one side, alternating as in an extended strand.
  const x = unit([ahead[0] - p[0], ahead[1] - p[1], ahead[2] - p[2]]);
  const ref: Vec = Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let y = unit([x[1] * ref[2] - x[2] * ref[1], x[2] * ref[0] - x[0] * ref[2], x[0] * ref[1] - x[1] * ref[0]]);
  if (j % 2) y = [-y[0], -y[1], -y[2]];
  const z: Vec = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const tint = TRNA_COLORS[j % TRNA_COLORS.length];
  const a = Math.round(alpha * 255);
  for (const [e, lx, ly, lz] of amino.templates[SEQUENCE[j]]) {
    wx[count] = p[0] + x[0] * lx + y[0] * ly + z[0] * lz;
    wy[count] = p[1] + x[1] * lx + y[1] * ly + z[1] * lz;
    wz[count] = p[2] + x[2] * lx + y[2] * ly + z[2] * lz;
    wr[count] = RADIUS[e] * BALL_SIZE * 1.3;
    // Carbons take the colour of the tRNA that brought the residue; N, O and S keep theirs.
    wc[count] = (((mode === "element" || e !== 0 ? CPK[e] : tint) & ~255) | a) >>> 0;
    count++;
  }
}

/** Rotates, projects and depth-sorts the world arrays into `pos`, `scale` and `colors`, farthest first. */
function project(w: number, h: number): void {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const px = (Math.min(w, h) / SPAN) * zoom; // pixels per angstrom at the centre
  const focal = CAMERA * px;
  for (let i = 0; i < count; i++) {
    const x1 = wx[i] * cy + wz[i] * sy;
    const z1 = -wx[i] * sy + wz[i] * cy;
    const y2 = wy[i] * cp - z1 * sp;
    const z2 = wy[i] * sp + z1 * cp; // toward the viewer
    depth[i] = z2;
    const k = focal / (CAMERA - z2);
    screen[i * 2] = x1 * k;
    screen[i * 2 + 1] = -y2 * k;
  }
  // Counting sort on depth across the bounding sphere (plus room for tRNAs on their way in or out):
  // a comparison sort of 150,000 floats every frame would cost more than drawing them.
  const far = -reach - 200;
  const range = 2 * reach + 400;
  start.fill(0);
  for (let i = 0; i < count; i++) {
    const b = Math.max(0, Math.min(BUCKETS - 1, ((depth[i] - far) / range) * BUCKETS)) | 0;
    bucketOf[i] = b;
    start[b + 1]++;
  }
  for (let b = 1; b <= BUCKETS; b++) start[b] += start[b - 1];
  for (let i = 0; i < count; i++) order[start[bucketOf[i]]++] = i;

  // Fill the draw arrays in sorted order, so later copies (nearer atoms) cover earlier ones.
  const ox = w / 2;
  const oy = h / 2;
  const lo = -reach + slab.back * 2 * reach;
  const hi = -reach + slab.front * 2 * reach;
  // With the slab wide open, keep the tRNAs drawn while they're outside the ribosome's sphere.
  const keepFar = slab.back === 0;
  const keepNear = slab.front === 1;
  let m = 0;
  for (let p = 0; p < count; p++) {
    const i = order[p];
    const z = depth[i];
    if ((z < lo && !keepFar) || (z > hi && !keepNear)) continue;
    const q = m++;
    const k = focal / (CAMERA - z);
    pos[q * 2] = ox + screen[i * 2];
    pos[q * 2 + 1] = oy + screen[i * 2 + 1];
    scale[q] = (wr[i] * 2 * k) / BALL;
    // Far atoms fade toward the background, so depth reads even when the ribosome is still.
    const light = 0.35 + 0.65 * Math.max(0, Math.min(1, (z + reach) / (2 * reach)));
    colors[q] = shade(wc[i], light);
  }
  shown = m;
}

let last = 0;
let fps = 60;
let simMs = 0;
let drawMs = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  if (!paused) {
    clock += dt;
    if (pointers.size === 0) yaw += spin * dt;
  }
  // Start over once the chain fills its path, so it never runs off the end.
  if (clock / CYCLE > SEQUENCE.length + 1) clock = 0;
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
  build(clock);
  project(w, h);
  const t1 = performance.now();
  draw.begin("#11140d", w, h, dpr);
  draw.sprites(ball, pos, shown, { smooth: true }, { scale, color: colors });
  draw.end();
  const t2 = performance.now();
  simMs += (t1 - t0 - simMs) * 0.05;
  drawMs += (t2 - t1 - drawMs) * 0.05;
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) {
    const residues = Math.min(SEQUENCE.length, Math.floor(clock / CYCLE) + 1);
    const latest = SEQUENCE[residues - 1].toLowerCase();
    stats.textContent = `${shown.toLocaleString()} atoms · protein L23, ${residues} of ${SEQUENCE.length} amino acids, last ${latest} · ${Math.round(fps)} fps · build and sort ${simMs.toFixed(1)} ms · draw ${drawMs.toFixed(1)} ms · ${draw.kind}`;
  }
  requestAnimationFrame(frame);
}

setPaused(paused);
setMode(mode);
press("backends", "backend", backend);
requestAnimationFrame(frame);
