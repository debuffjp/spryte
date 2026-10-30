// An ant colony that finds food with nothing but scent. Two scent fields live on a coarse grid: ants
// heading out lay "home" scent, ants carrying food lay "food" scent, and each follows the other kind.
// Scent fades, so the shortest routes are the ones refreshed most often and the trails straighten out.
// The fields are one small image redrawn each frame; the ants are one sprites() call.
import { createRenderer, type Draw, ring } from "spryte";

const CAP = 40_000;
const CELL = 4; // px per scent cell
const SPEED = 55; // px/s
const SENSE = 14; // how far ahead an ant smells, px
const SENSE_ANGLE = 0.6; // radians either side
const TURN = 7; // radians/s toward the strongest smell
const WANDER = 3; // radians/s of random wobble
const FADE = 0.12; // scent lost per second, as a fraction
const TRAIL = 12; // s for a trail's strength to fall to a third
const HOME_PULL = 2.5; // radians/s a carrier turns toward its sense of home
const GIVE_UP = 60; // s searching before an ant heads home and starts again
const NEST_R = 18;
const PILE = 60; // food units per cell in a fresh pile

const ax = new Float32Array(CAP * 2); // positions, read by sprites()
const angle = new Float32Array(CAP);
const since = new Float32Array(CAP); // seconds since leaving the nest or finding food
const carrying = new Uint8Array(CAP);
const bias = new Float32Array(CAP); // each carrier's error in its sense of home, radians
const colors = new Uint32Array(CAP);
const SEEK = 0xd9dccfcc;
const CARRY = 0xfbbf24ff;

let cols = 0;
let rows = 0;
let home = new Float32Array(0); // scent fields
let food = new Float32Array(0);
let pile = new Uint16Array(0); // food left per cell
let wall = new Uint8Array(0);
let field: OffscreenCanvas;
let pixels: ImageData;
let nest = { x: 0, y: 0 };
let delivered = 0;
let foodLeft = 0;
let dirty = true; // the field needs repainting even while paused
const hover = { x: 0, y: 0, on: false };
const TOOL_COLOR = { food: "#fbbf24", wall: "#a3ab96", erase: "#ffffff88" };

// A 5x3 ant, made at runtime so the demo has no assets.
const antTex = new OffscreenCanvas(5, 3);
{
  const g = antTex.getContext("2d") as OffscreenCanvasRenderingContext2D;
  g.fillStyle = "#fff";
  g.fillRect(0, 1, 5, 1);
  g.fillRect(1, 0, 3, 3);
}

const params = new URLSearchParams(location.search);
let backend: "auto" | "2d" = params.get("backend") === "2d" ? "2d" : "auto";
let n = innerWidth < 600 ? 2000 : 10000;
let tool: "food" | "wall" | "erase" = "food";
let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;

const stage = document.getElementById("stage") as HTMLDivElement;
const stats = document.getElementById("stats") as HTMLDivElement;
const pauseButton = document.getElementById("pause") as HTMLButtonElement;
let canvas = document.createElement("canvas");
stage.append(canvas);
let draw: Draw = createRenderer(canvas, { backend });

function press(group: string, attr: string, value: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`#${group} button`))
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
}
function setPaused(p: boolean): void {
  paused = p;
  pauseButton.textContent = p ? "Play" : "Pause";
  pauseButton.setAttribute("aria-pressed", String(p));
}

/** Fills a disc of cells: food piles, walls or nothing. */
function paint(x: number, y: number, r: number, what: "food" | "wall" | "erase"): void {
  const c0 = Math.floor(x / CELL);
  const r0 = Math.floor(y / CELL);
  const rc = Math.ceil(r / CELL);
  for (let dy = -rc; dy <= rc; dy++)
    for (let dx = -rc; dx <= rc; dx++) {
      if (dx * dx + dy * dy > rc * rc) continue;
      const cx = c0 + dx;
      const cy = r0 + dy;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      // Keep the nest clear, or the colony could be walled in or buried in food.
      if (Math.hypot(cx * CELL - nest.x, cy * CELL - nest.y) < NEST_R + 6) continue;
      const k = cy * cols + cx;
      wall[k] = what === "wall" ? 1 : 0;
      foodLeft += (what === "food" ? PILE : 0) - pile[k];
      pile[k] = what === "food" ? PILE : 0;
      if (what !== "erase") home[k] = food[k] = 0;
    }
  dirty = true;
}

function reset(): void {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  cols = Math.ceil(w / CELL);
  rows = Math.ceil(h / CELL);
  home = new Float32Array(cols * rows);
  food = new Float32Array(cols * rows);
  pile = new Uint16Array(cols * rows);
  wall = new Uint8Array(cols * rows);
  field = new OffscreenCanvas(cols, rows);
  pixels = new ImageData(cols, rows);
  nest = { x: w * 0.5, y: h * 0.55 };
  delivered = 0;
  foodLeft = 0;
  // Three piles to start: near, far and behind a wall, so there's a detour to find.
  paint(w * 0.22, h * 0.3, 22, "food");
  paint(w * 0.82, h * 0.25, 26, "food");
  paint(w * 0.75, h * 0.8, 18, "food");
  for (let t = 0; t <= 1; t += 0.01) paint(w * 0.62, h * (0.55 + 0.35 * t), 5, "wall");
  for (let i = 0; i < CAP; i++) spawn(i);
}
function spawn(i: number): void {
  ax[i * 2] = nest.x;
  ax[i * 2 + 1] = nest.y;
  angle[i] = Math.random() * Math.PI * 2;
  since[i] = 0;
  carrying[i] = 0;
}

document.getElementById("tools")?.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).dataset.tool as typeof tool | undefined;
  if (!t) return;
  tool = t;
  press("tools", "tool", t);
});
document.getElementById("counts")?.addEventListener("click", (e) => {
  const c = Number((e.target as HTMLElement).dataset.count);
  if (!c) return;
  for (let i = n; i < c; i++) spawn(i); // newcomers start at the nest
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
pauseButton.addEventListener("click", () => setPaused(!paused));
document.getElementById("reset")?.addEventListener("click", reset);

let drawing = false;
function brush(e: PointerEvent): void {
  const r = stage.getBoundingClientRect();
  hover.x = e.clientX - r.left;
  hover.y = e.clientY - r.top;
  hover.on = e.pointerType === "mouse" || drawing;
  if (!drawing) return;
  paint(e.clientX - r.left, e.clientY - r.top, tool === "food" ? 14 : 8, tool);
}
stage.addEventListener("pointerdown", (e) => {
  drawing = true;
  stage.setPointerCapture(e.pointerId);
  brush(e);
});
stage.addEventListener("pointermove", brush);
stage.addEventListener("pointerup", (e) => {
  drawing = false;
  if (e.pointerType !== "mouse") hover.on = false;
});
stage.addEventListener("pointerleave", () => {
  hover.on = false;
});

function at(f: Float32Array, x: number, y: number): number {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return -1;
  const k = cy * cols + cx;
  if (wall[k]) return -1;
  // Food smells strongest of all to an ant that's looking for it.
  return f === food && pile[k] ? 1000 : f[k];
}

/** Turns `a` toward `target` by at most `max` radians. */
function steer(a: number, target: number, max: number): number {
  let d = target - a;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return a + Math.max(-max, Math.min(max, d));
}

const SENSE_COS = Math.cos(SENSE_ANGLE);
const SENSE_SIN = Math.sin(SENSE_ANGLE);

/** Smell over a small patch: two samples across the ant's path, so one stray cell doesn't decide the way. */
function patch(f: Float32Array, x: number, y: number, px: number, py: number): number {
  return at(f, x + px, y + py) + at(f, x - px, y - py);
}

/**
 * Turns toward whichever of left, ahead and right smells strongest of `f`. The side sensors come from
 * rotating the heading vector by a fixed angle, so there's one cos and sin per ant instead of six.
 */
function follow(f: Float32Array, x: number, y: number, a: number, max: number): number {
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const px = -sn * 3; // across the path
  const py = c * 3;
  const lc = c * SENSE_COS + sn * SENSE_SIN;
  const ls = sn * SENSE_COS - c * SENSE_SIN;
  const rc = c * SENSE_COS - sn * SENSE_SIN;
  const rs = sn * SENSE_COS + c * SENSE_SIN;
  const left = patch(f, x + lc * SENSE, y + ls * SENSE, px, py);
  const ahead = patch(f, x + c * SENSE, y + sn * SENSE, px, py);
  const right = patch(f, x + rc * SENSE, y + rs * SENSE, px, py);
  if (left > ahead && left > right) return a - max;
  if (right > ahead && right > left) return a + max;
  return a;
}

function blocked(x: number, y: number, w: number, h: number): boolean {
  return x < 0 || y < 0 || x >= w || y >= h || wall[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] === 1;
}

function step(dt: number, w: number, h: number): void {
  const fade = 1 - FADE * dt;
  for (let k = 0; k < home.length; k++) {
    home[k] *= fade;
    food[k] *= fade;
  }
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    let x = ax[j];
    let y = ax[j + 1];
    let a = angle[i];
    const loaded = carrying[i] === 1;
    since[i] += dt;
    if (loaded) {
      // Carriers steer home mainly by path integration, as real foraging ants do: a running sense of the
      // nest's direction, a little off for each ant. Home scent only nudges them, which takes them round
      // walls. Steering by scent alone sent carriers round closed loops of each other's trails.
      const dx = nest.x - x;
      const dy = nest.y - y;
      const near = dx * dx + dy * dy < 60 * 60; // close enough to see the nest
      a = steer(a, Math.atan2(dy, dx) + (near ? 0 : bias[i]), (near ? 8 : HOME_PULL) * dt);
      a = follow(home, x, y, a, TURN * 0.4 * dt);
    } else {
      if (since[i] > GIVE_UP) {
        spawn(i); // a searcher out too long goes home and starts again
        continue;
      }
      // Searchers follow the food scent laid by carriers coming back.
      a = follow(food, x, y, a, TURN * dt);
    }
    a += (Math.random() - 0.5) * 2 * WANDER * dt;
    const nx = x + Math.cos(a) * SPEED * dt;
    const ny = y + Math.sin(a) * SPEED * dt;
    if (blocked(nx, ny, w, h)) {
      // Bump: slide along the obstacle if either side is free, otherwise turn round. The slide angle varies
      // so carriers pressed against a wall spread out instead of queueing in one line.
      const side = (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.8);
      if (!blocked(x + Math.cos(a + side) * 4, y + Math.sin(a + side) * 4, w, h)) a += side;
      else if (!blocked(x + Math.cos(a - side) * 4, y + Math.sin(a - side) * 4, w, h)) a -= side;
      else a += Math.PI + (Math.random() - 0.5);
    } else {
      x = nx;
      y = ny;
    }
    const k = Math.floor(y / CELL) * cols + Math.floor(x / CELL);
    // Lay scent for the other trip, weaker the longer since the last stop. A cell keeps the freshest scent
    // rather than the sum: summed scent saturated on busy trails, lost its slope and sent ants round in loops,
    // while the freshest scent always rises toward where it came from.
    const strength = Math.exp(-since[i] / TRAIL);
    if (loaded) food[k] = Math.max(food[k], strength);
    else home[k] = Math.max(home[k], strength);
    if (!loaded && pile[k]) {
      pile[k]--;
      foodLeft--;
      carrying[i] = 1;
      bias[i] = (Math.random() - 0.5) * 0.25;
      since[i] = 0;
      a += Math.PI;
    } else if (loaded && (x - nest.x) ** 2 + (y - nest.y) ** 2 < NEST_R * NEST_R) {
      carrying[i] = 0;
      since[i] = 0;
      delivered++;
      a += Math.PI;
    }
    ax[j] = x;
    ax[j + 1] = y;
    angle[i] = a;
    colors[i] = carrying[i] ? CARRY : SEEK;
  }
}

/** Paints scent, food and walls into the field image: one pixel per cell. */
function paintField(): void {
  const d = pixels.data;
  for (let k = 0; k < home.length; k++) {
    const p = k * 4;
    if (wall[k]) {
      d[p] = 0x5a;
      d[p + 1] = 0x63;
      d[p + 2] = 0x4c;
      d[p + 3] = 255;
      continue;
    }
    if (pile[k]) {
      d[p] = 0xfb;
      d[p + 1] = 0xbf;
      d[p + 2] = 0x24;
      d[p + 3] = 120 + Math.min(135, pile[k] * 2);
      continue;
    }
    // Food scent (the colony recruiting) is the story, so it's lime and bright; home scent is a faint blue
    // underlay. Squaring the strength keeps weak, fading scent nearly invisible, so busy trails stand out
    // instead of the whole field filling with haze.
    const fd = Math.min(1, food[k] * 1.4);
    const hm = Math.min(1, home[k] * 1.4);
    const fa = fd * fd * 235;
    const ha = hm * hm * 70;
    if (fa >= ha) {
      d[p] = 0xcf;
      d[p + 1] = 0xfb;
      d[p + 2] = 0x2d;
      d[p + 3] = fa;
    } else {
      d[p] = 0x38;
      d[p + 1] = 0xbd;
      d[p + 2] = 0xf8;
      d[p + 3] = ha;
    }
  }
  (field.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(pixels, 0, 0);
  draw.invalidate(field);
}

let last = 0;
let fps = 60;
let simMs = 0;
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (Math.ceil(w / CELL) !== cols || Math.ceil(h / CELL) !== rows) reset();
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    draw.resize(pw, ph);
  }
  const t0 = performance.now();
  if (!paused) step(dt, w, h);
  simMs += (performance.now() - t0 - simMs) * 0.05;
  // While paused the field only changes when someone paints on it.
  if (!paused || dirty) paintField();
  dirty = false;
  draw.begin("#11140d", w, h, dpr);
  draw.sprite(field, 0, 0, { origin: [0, 0], scaleX: CELL, scaleY: CELL, smooth: true });
  draw.circle(nest.x, nest.y, NEST_R, "#38bdf8");
  draw.sprites(antTex, ax, n, undefined, { rotation: angle, color: colors });
  // Show the brush under the pointer, in the colour of what it paints.
  if (hover.on) ring(draw, hover.x, hover.y, tool === "food" ? 14 : 8, 1.5, TOOL_COLOR[tool]);
  draw.end();
  if (Math.floor(now / 250) !== Math.floor((now - dt * 1000) / 250))
    stats.textContent = `${n.toLocaleString()} ants · ${delivered.toLocaleString()} food brought home · ${foodLeft ? `${foodLeft.toLocaleString()} left` : "all eaten: drop more food"} · ${Math.round(fps)} fps · simulate ${simMs.toFixed(1)} ms · ${draw.kind}`;
  requestAnimationFrame(frame);
}

press("tools", "tool", tool);
press("counts", "count", String(n));
press("backends", "backend", backend);
setPaused(paused);
requestAnimationFrame(frame);
