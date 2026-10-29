// NASA's recorded meteorite landings, every one a dot that flies between a world map, a histogram
// of mass, a timeline and a year-by-year replay of the map. A lens highlights the dots under it and summarises them. All the dots
// are drawn with one sprites() call, and the header switches to the Canvas 2D fallback or
// multiplies the data so you can see where each renderer runs out.
// Data: NASA Open Data Portal, from The Meteoritical Society (see convert.mjs).
import { createRenderer, type Draw, ring } from "spryte";

type View = "map" | "replay" | "mass" | "year";
const FELL = 0xcffb2d; // lime, as on debuff.jp
const FOUND = 0x38bdf8;
const MIN_LOG = -2; // 0.01 g
const MAX_LOG = 8; // 100 t
const FIRST_YEAR = 1900; // earlier years share the first column
const LAST_YEAR = 2013;
const REPLAY_FROM = 1880;
const REPLAY_YEARS_PER_SECOND = 9;
const REPLAY_HOLD = 2.5; // seconds on the finished map before the replay loops
const CAPTIONS: Record<View, string> = {
  map: "Where they were found. Over two thirds are from Antarctica, piled onto a few dozen collection sites along the bottom edge: aim the lens there.",
  replay:
    "Year by year since 1880. Antarctica fills in from the 1970s, the Sahara in the 1990s and Oman in the 2000s, as searches reached each one.",
  mass: "How heavy they are, from 0.01 g to 60 t, on a log scale. Falls (lime) skew heavier: someone has to see them.",
  year: "When they were recorded. Most arrived after 1975, when expeditions started combing the Antarctic ice.",
};

// meteorites.bin: see convert.mjs for the layout.
const data = await (await fetch(new URL("./meteorites.bin", import.meta.url))).arrayBuffer();
const BASE = new DataView(data).getUint32(0, true);
const lon = new Int16Array(data, 4, BASE);
const lat = new Int16Array(data, 4 + BASE * 2, BASE);
const logMass = new Uint16Array(data, 4 + BASE * 4, BASE);
const year = new Uint16Array(data, 4 + BASE * 6, BASE);
const fell = new Uint8Array(data, 4 + BASE * 8, BASE);

let seed = 7;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

// Per-point data, sized for the most copies. Copies after the first are jittered slightly so
// they don't sit exactly on the original.
const MAX_COPIES = 8;
const CAP = BASE * MAX_COPIES;
const mapX = new Float32Array(CAP); // 0-1
const mapY = new Float32Array(CAP);
const mass = new Float32Array(CAP); // 0-1 along the mass axis
const time = new Float32Array(CAP); // 0-1 along the year axis
const base = new Uint32Array(CAP); // 0xRRGGBB
const rate = new Float32Array(CAP); // how fast each point chases its target, so a move flows
const order = new Uint32Array(CAP); // falls first, so they stack at the bottom of each column
for (let i = 0; i < CAP; i++) {
  const j = i % BASE;
  const copy = i >= BASE;
  mapX[i] = (lon[j] / 100 + 180) / 360 + (copy ? (rand() - 0.5) * 0.004 : 0);
  mapY[i] = (90 - lat[j] / 100) / 180 + (copy ? (rand() - 0.5) * 0.008 : 0);
  mass[i] = Math.min(0.999, (logMass[j] / 1000 - 2 - MIN_LOG) / (MAX_LOG - MIN_LOG));
  time[i] = Math.min(0.999, Math.max(0, (year[j] - FIRST_YEAR) / (LAST_YEAR + 1 - FIRST_YEAR)));
  base[i] = fell[j] ? FELL : FOUND;
  rate[i] = 3 + rand() * 5;
}
{
  let k = 0;
  for (let i = 0; i < CAP; i++) if (fell[i % BASE]) order[k++] = i;
  for (let i = 0; i < CAP; i++) if (!fell[i % BASE]) order[k++] = i;
}

const positions = new Float32Array(CAP * 2);
const targets = new Float32Array(CAP * 2);
const colors = new Uint32Array(CAP);
const scales = new Float32Array(CAP).fill(0.5);
const BINS = 57;
const counts = new Uint32Array(BINS);
const filled = new Uint32Array(BINS);
const massBins = new Uint32Array(100);

// A 6x6 dot made at runtime, so the example has no assets.
const dot = new OffscreenCanvas(6, 6);
{
  const g = dot.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(3, 3, 3, 0, Math.PI * 2);
  g.fill();
}

// State, mirrored into the header buttons.
const params = new URLSearchParams(location.search);
let view: View = "map";
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let n = BASE;
let auto = true; // views cycle and the lens drifts until someone takes over
let lastInput = -1e9;
let viewSince = 0;
let replayYear = REPLAY_FROM;
const lens = { x: 0, y: 0, r: 60, on: false };

const stage = document.getElementById("stage") as HTMLDivElement;
if (innerWidth < 600) lens.r = 32; // a phone map is small
const caption = document.getElementById("caption") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
let canvas = document.createElement("canvas");
let draw: Draw = makeRenderer();

function makeRenderer(): Draw {
  // A canvas keeps the first context type it gets, so switching renderer means a new canvas.
  const next = document.createElement("canvas");
  canvas.replaceWith(next);
  if (!next.isConnected) stage.append(next);
  canvas = next;
  return createRenderer(canvas, { backend });
}

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
function setView(v: View, now: number): void {
  view = v;
  viewSince = now;
  replayYear = REPLAY_FROM;
  caption.textContent = CAPTIONS[v];
  press("views", "view", v);
  layoutKey = "";
}
function takeOver(): void {
  auto = false;
  lastInput = performance.now();
}
document.getElementById("views")?.addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).dataset.view as View | undefined;
  if (v) {
    takeOver();
    setView(v, performance.now());
  }
});
document.getElementById("backends")?.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).dataset.backend as "auto" | "2d" | undefined;
  if (!b || b === backend) return;
  backend = b;
  draw.dispose();
  draw = makeRenderer();
  press("backends", "backend", b);
  layoutKey = "";
});
document.getElementById("copies")?.addEventListener("click", (e) => {
  const c = Number((e.target as HTMLElement).dataset.copies);
  if (!c) return;
  // New copies start where their original is, then spread to their own targets.
  for (let i = n; i < BASE * c; i++) {
    const j = (i % BASE) * 2;
    positions[i * 2] = positions[j];
    positions[i * 2 + 1] = positions[j + 1];
  }
  n = BASE * c;
  press("copies", "copies", String(c));
  layoutKey = "";
});
function aim(e: PointerEvent): void {
  const r = stage.getBoundingClientRect();
  lens.x = e.clientX - r.left;
  lens.y = e.clientY - r.top;
  lens.on = true;
  takeOver();
}
stage.addEventListener("pointermove", aim);
stage.addEventListener("pointerdown", aim);
stage.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "mouse") lens.on = false;
});
stage.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    lens.r = Math.min(240, Math.max(16, lens.r * Math.exp(-e.deltaY * 0.001)));
    takeOver();
  },
  { passive: false },
);
addEventListener("keydown", (e) => {
  const v = ({ "1": "map", "2": "replay", "3": "mass", "4": "year" } as Record<string, View>)[e.key];
  if (v) {
    takeOver();
    setView(v, performance.now());
  }
});

// Where everything goes in the current view. Recomputed only when the view, size or count changes.
const box = { x: 0, y: 0, w: 0, h: 0 };
let layoutKey = "";
function layout(w: number, h: number): void {
  const key = `${view} ${w} ${h} ${n}`;
  if (key === layoutKey) return;
  layoutKey = key;
  const pad = 16;
  const bottom = 22; // room for axis labels
  if (view === "map" || view === "replay") {
    // An equirectangular map keeps its 2:1 shape.
    const mw = Math.min(w - pad * 2, (h - pad - bottom) * 2);
    box.w = mw;
    box.h = mw / 2;
    box.x = (w - mw) / 2;
    box.y = Math.max(pad, (h - bottom - box.h) / 2);
    for (let i = 0; i < n; i++) {
      targets[i * 2] = box.x + mapX[i] * box.w;
      targets[i * 2 + 1] = box.y + mapY[i] * box.h;
    }
    return;
  }
  box.x = pad;
  box.y = pad;
  box.w = w - pad * 2;
  box.h = h - pad - bottom;
  const value = view === "mass" ? mass : time;
  counts.fill(0);
  for (let i = 0; i < n; i++) counts[Math.floor(value[i] * BINS)]++;
  let tallest = 1;
  for (let b = 0; b < BINS; b++) tallest = Math.max(tallest, counts[b]);
  const colW = box.w / BINS;
  const across = Math.max(1, Math.floor((colW - 1) / 3));
  // Dots sit 3 px apart; rows squeeze together when the tallest column would overflow.
  const rowStep = Math.min(3, (box.h * across) / tallest);
  filled.fill(0);
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const b = Math.floor(value[i] * BINS);
    const slot = filled[b]++;
    targets[i * 2] = box.x + b * colW + 2 + (slot % across) * 3;
    targets[i * 2 + 1] = box.y + box.h - Math.floor(slot / across) * rowStep;
  }
}

function resize(): number {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = Math.round(stage.clientWidth * dpr);
  const h = Math.round(stage.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    draw.resize(w, h);
  }
  return dpr;
}

function axes(): void {
  const font = "11px sans-serif";
  const label = { font, color: "#777", align: "center" as const };
  const y = box.y + box.h + 6;
  if (view === "map" || view === "replay") {
    for (let d = -150; d <= 150; d += 30) {
      const x = box.x + ((d + 180) / 360) * box.w;
      draw.rect(x, box.y, 1, box.h, "#1b2113");
    }
    for (let d = -60; d <= 60; d += 30) {
      const ly = box.y + ((90 - d) / 180) * box.h;
      draw.rect(box.x, ly, box.w, 1, d === 0 ? "#28301d" : "#1b2113");
    }
    return;
  }
  draw.rect(box.x, box.y + box.h + 2, box.w, 1, "#2c3521");
  const ticks: [number, string][] =
    view === "mass"
      ? [
          [0, "1 g"],
          [3, "1 kg"],
          [6, "1 t"],
        ].map(([l, s]) => [((l as number) - MIN_LOG) / (MAX_LOG - MIN_LOG), s as string])
      : [1925, 1950, 1975, 2000].map((yr) => [(yr - FIRST_YEAR) / (LAST_YEAR + 1 - FIRST_YEAR), String(yr)]);
  for (const [t, s] of ticks) draw.text(s, box.x + t * box.w, y, label);
  if (view === "year") draw.text("before 1900", box.x, y, { font, color: "#777" });
}

let last = 0;
let fps = 60;
let work = 0;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const t0 = performance.now();
  const dpr = resize();
  const w = stage.clientWidth;
  const h = stage.clientHeight;

  if (!auto && now - lastInput > 12000) auto = true;
  if (auto) {
    const replayLength = ((LAST_YEAR + 1 - REPLAY_FROM) / REPLAY_YEARS_PER_SECOND + REPLAY_HOLD) * 1000;
    if (now - viewSince > (view === "replay" ? replayLength : 5000)) {
      const next: Record<View, View> = { map: "replay", replay: "mass", mass: "year", year: "map" };
      setView(next[view], now);
    }
    const s = now / 1000;
    lens.x = w * (0.5 + 0.3 * Math.sin(s * 0.37));
    lens.y = h * (0.5 + 0.25 * Math.sin(s * 0.61 + 1));
    lens.on = true;
  }
  layout(w, h);
  const replaying = view === "replay";
  if (replaying) {
    replayYear += dt * REPLAY_YEARS_PER_SECOND;
    if (replayYear > LAST_YEAR + 1 + REPLAY_HOLD * REPLAY_YEARS_PER_SECOND) replayYear = REPLAY_FROM;
  }
  const shownYear = Math.min(replayYear, LAST_YEAR + 1);
  let shown = 0;

  // Every point eases toward its target; the lens tallies what it covers and lights it up.
  const r2 = lens.r * lens.r;
  let under = 0;
  let underFell = 0;
  massBins.fill(0);
  const dim = lens.on ? 0x66 : 0xcc;
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    const k = 1 - Math.exp(-dt * rate[i]);
    const x = positions[j] + (targets[j] - positions[j]) * k;
    const y = positions[j + 1] + (targets[j + 1] - positions[j + 1]) * k;
    positions[j] = x;
    positions[j + 1] = y;
    let scale = 0.5;
    if (replaying) {
      // Not recorded yet: hidden. Just recorded: a bright pop that settles over about two years.
      const age = shownYear - year[i % BASE];
      if (age < 0) {
        colors[i] = 0;
        scales[i] = 0;
        continue;
      }
      shown++;
      if (age < 2) scale = 0.5 + (1 - age / 2) * 1.5;
    }
    scales[i] = scale;
    const dx = x - lens.x;
    const dy = y - lens.y;
    if (lens.on && dx * dx + dy * dy < r2) {
      under++;
      if (fell[i % BASE]) underFell++;
      massBins[Math.floor(mass[i] * 100)]++;
      colors[i] = ((base[i] << 8) | 0xff) >>> 0;
    } else colors[i] = ((base[i] << 8) | (scale > 0.5 ? 0xff : dim)) >>> 0;
  }

  draw.begin("#11140d", w, h, dpr);
  axes();
  draw.sprites(dot, positions, n, undefined, { color: colors, scale: scales });
  if (replaying) {
    const y = Math.floor(shownYear);
    draw.text(String(Math.min(y, LAST_YEAR)), box.x + 8, box.y + 6, { font: "bold 28px sans-serif", color: "#ddd" });
    draw.text(`${shown.toLocaleString()} recorded`, box.x + 8, box.y + 40, { font: "12px sans-serif", color: "#888" });
    const t = (shownYear - REPLAY_FROM) / (LAST_YEAR + 1 - REPLAY_FROM);
    draw.rect(box.x, box.y + box.h + 8, box.w, 2, "#28301d");
    draw.rect(box.x, box.y + box.h + 8, box.w * Math.max(0, t), 2, "#999");
  }
  if (lens.on) ring(draw, lens.x, lens.y, lens.r, 1.5, "#ffffffaa");
  draw.end();
  work += (performance.now() - t0 - work) * 0.05;

  let median = "";
  if (under) {
    let seen = 0;
    for (let b = 0; b < 100; b++) {
      seen += massBins[b];
      if (seen * 2 >= under) {
        const grams = 10 ** (MIN_LOG + ((b + 0.5) / 100) * (MAX_LOG - MIN_LOG));
        median =
          grams >= 1e6
            ? `${Number((grams / 1e6).toPrecision(2))} t`
            : grams >= 1000
              ? `${Number((grams / 1000).toPrecision(2))} kg`
              : `${Number(grams.toPrecision(2))} g`;
        break;
      }
    }
  }
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250)) {
    const lensText = under
      ? `lens: ${under.toLocaleString()} (${Math.round((underFell / under) * 100)}% seen falling, median ${median})`
      : "lens: empty";
    stats.textContent = `${lensText} · ${n.toLocaleString()} points · ${Math.round(fps)} fps · ${work.toFixed(1)} ms of JS per frame · ${draw.kind} · ${draw.drawCalls} draw calls`;
  }
  requestAnimationFrame(frame);
}

(document.getElementById("title") as HTMLElement).textContent = `${BASE.toLocaleString()} meteorites`;
press("backends", "backend", backend);
press("copies", "copies", "1");
setView("map", performance.now());
// Start every point at the centre so the first layout flies them out.
for (let i = 0; i < CAP; i++) {
  positions[i * 2] = stage.clientWidth / 2;
  positions[i * 2 + 1] = stage.clientHeight / 2;
}
requestAnimationFrame(frame);
