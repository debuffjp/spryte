import type { Matrix } from "./backend.js";
import { type Color, toRGBA } from "./color.js";
import type { Draw } from "./draw.js";

/**
 * Filled polygon through `points` (x0, y0, x1, y1, …), antialiased. Concave is fine; it closes itself and
 * shouldn't cross itself. `count` defaults to every pair in `points`.
 *
 * ```ts
 * import { polygon } from "spryte";
 * polygon(draw, [0, 0, 20, 0, 10, 16], "#cffb2d");
 * ```
 */
export function polygon(draw: Draw, points: ArrayLike<number>, color: Color, count = points.length >> 1): void {
  path(draw, points, count, true, 0, color);
}

/** Line through `points` (x0, y0, x1, y1, …), `width` wide, with mitred joins and flat ends. `closed` joins the last point to the first. */
export function polyline(
  draw: Draw,
  points: ArrayLike<number>,
  width: number,
  color: Color,
  closed = false,
  count = points.length >> 1,
): void {
  if (width > 0) path(draw, points, count, closed, width, color);
}

/** Rectangle with rounded corners: filled, or outlined when `lineWidth` is given (the outline is centred on the edge). */
export function roundRect(draw: Draw, x: number, y: number, w: number, h: number, radius: number, color: Color, lineWidth?: number): void {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  const steps = r > 0 ? arcSteps(draw, r, Math.PI / 2) : 0;
  const pts = scratch((steps + 1) * 8);
  let k = 0;
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= steps; i++) {
      const a = from + (i / Math.max(steps, 1)) * (Math.PI / 2);
      pts[k++] = cx + Math.cos(a) * r;
      pts[k++] = cy + Math.sin(a) * r;
    }
  };
  corner(x + w - r, y + r, -Math.PI / 2);
  corner(x + w - r, y + h - r, 0);
  corner(x + r, y + h - r, Math.PI / 2);
  corner(x + r, y + r, Math.PI);
  path(draw, pts, k >> 1, true, lineWidth ?? 0, color);
}

/** Circle outline, `width` wide, centred on `radius`. */
export function ring(draw: Draw, x: number, y: number, radius: number, width: number, color: Color): void {
  if (radius <= 0 || width <= 0) return;
  const steps = arcSteps(draw, radius, Math.PI * 2);
  const pts = scratch(steps * 2);
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts[i * 2] = x + Math.cos(a) * radius;
    pts[i * 2 + 1] = y + Math.sin(a) * radius;
  }
  path(draw, pts, steps, true, width, color);
}

function path(draw: Draw, points: ArrayLike<number>, n: number, closed: boolean, width: number, color: Color): void {
  if (n < 2) return;
  const m = draw.m;
  // One device pixel in local units, for the WebGL2 edge feather.
  const aa = 1 / (draw.renderScale * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1);
  draw.quads++;
  draw.backend.path(m, points, n, closed, width, draw.withAlpha(toRGBA(color), 1), aa, ShapeBuffer);
}

/** Segments for an arc of `radius` spanning `angle`: about one per 4 device pixels of arc, at least 2. */
function arcSteps(draw: Draw, radius: number, angle: number): number {
  const m = draw.m;
  const device = radius * Math.hypot(m[0], m[1]) * draw.renderScale;
  return Math.max(2, Math.min(256, Math.ceil((device * angle) / 4)));
}

let points = new Float32Array(64);
function scratch(n: number): Float32Array {
  if (points.length < n) points = new Float32Array(2 ** Math.ceil(Math.log2(n)));
  return points;
}

/** Longest miter, in half line widths, before it's cut short (Canvas 2D bevels past the same limit). */
const MITER = 4;

/**
 * Indexed triangles for the WebGL2 backend's `path()`: x, y, u, v (floats), a colour (RGBA bytes) and coverage,
 * flash and texture unit (bytes) per vertex, 24 bytes. Sprites can join as textured quads (`sprite`). Edges get a feather one device pixel wide fading to coverage 0, which antialiases without MSAA.
 * @internal
 */
export class ShapeBuffer {
  data = new ArrayBuffer(1 << 16);
  f32 = new Float32Array(this.data);
  u32 = new Uint32Array(this.data);
  indices = new Uint32Array(1 << 14);
  /** Vertices and indices written. */
  count = 0;
  icount = 0;
  private m: Matrix = [1, 0, 0, 1, 0, 0];
  private color = 0;
  private xs = new Float64Array(64);
  private ys = new Float64Array(64);
  private nx = new Float64Array(64);
  private ny = new Float64Array(64);
  /** The inner ring of a fill, in the points' units (for ear clipping). */
  private ix = new Float64Array(64);
  private iy = new Float64Array(64);

  /** Fill (`width` 0) or stroke `n` points. `aa` is one device pixel in the points' units; `color` is RGBA bytes in memory order. */
  add(m: Matrix, points: ArrayLike<number>, n: number, closed: boolean, width: number, color: number, aa: number): void {
    this.m = m;
    this.color = color;
    n = this.load(points, n, closed || width === 0);
    if (width === 0) this.fill(n, aa);
    else this.stroke(n, closed, width, aa);
  }

  /** Copy points, dropping repeats; returns how many are left. Closed shapes also drop a last point equal to the first. */
  private load(points: ArrayLike<number>, n: number, closed: boolean): number {
    if (this.xs.length < n) {
      const size = 2 ** Math.ceil(Math.log2(n));
      this.xs = new Float64Array(size);
      this.ys = new Float64Array(size);
      this.nx = new Float64Array(size);
      this.ny = new Float64Array(size);
      this.ix = new Float64Array(size);
      this.iy = new Float64Array(size);
    }
    let k = 0;
    for (let i = 0; i < n; i++) {
      const x = points[i * 2] as number;
      const y = points[i * 2 + 1] as number;
      if (k > 0 && x === this.xs[k - 1] && y === this.ys[k - 1]) continue;
      this.xs[k] = x;
      this.ys[k] = y;
      k++;
    }
    if (closed && k > 1 && this.xs[0] === this.xs[k - 1] && this.ys[0] === this.ys[k - 1]) k--;
    return k;
  }

  /** Miter normals (left of travel) scaled so offsetting by 1 moves each edge by 1, clamped at MITER. */
  private normals(n: number, closed: boolean): void {
    const { xs, ys, nx, ny } = this;
    for (let i = 0; i < n; i++) {
      const p = i > 0 ? i - 1 : closed ? n - 1 : i;
      const q = i < n - 1 ? i + 1 : closed ? 0 : i;
      // Left normals of the edges into and out of this point.
      let ax = (ys[p] as number) - (ys[i] as number);
      let ay = (xs[i] as number) - (xs[p] as number);
      let bx = (ys[i] as number) - (ys[q] as number);
      let by = (xs[q] as number) - (xs[i] as number);
      const la = Math.sqrt(ax * ax + ay * ay);
      const lb = Math.sqrt(bx * bx + by * by);
      if (la > 0) {
        ax /= la;
        ay /= la;
      }
      if (lb > 0) {
        bx /= lb;
        by /= lb;
      }
      if (la === 0) {
        ax = bx;
        ay = by;
      } else if (lb === 0) {
        bx = ax;
        by = ay;
      }
      let mx = ax + bx;
      let my = ay + by;
      const lm = Math.sqrt(mx * mx + my * my);
      if (lm < 1e-9) {
        mx = ax;
        my = ay;
      } else {
        mx /= lm;
        my /= lm;
        const s = Math.min(MITER, 1 / Math.max(mx * ax + my * ay, 1e-9));
        mx *= s;
        my *= s;
      }
      nx[i] = mx;
      ny[i] = my;
    }
  }

  private fill(n: number, aa: number): void {
    if (n < 3) return;
    const { xs, ys, nx, ny, ix, iy } = this;
    // Wind one way, so left normals point inward.
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += (xs[j] as number) * (ys[i] as number) - (xs[i] as number) * (ys[j] as number);
    if (area === 0) return;
    if (area < 0) {
      xs.subarray(0, n).reverse();
      ys.subarray(0, n).reverse();
    }
    this.normals(n, true);
    const h = aa / 2;
    const isConvex = convex(xs, ys, n);
    // Inner ring (coverage 1) a half pixel in, then the outer ring (coverage 0) a half pixel out.
    const base = this.reserve(2 * n, 3 * (n - 2) + 6 * n);
    for (let i = 0; i < n; i++) {
      ix[i] = (xs[i] as number) + (nx[i] as number) * h;
      iy[i] = (ys[i] as number) + (ny[i] as number) * h;
      this.vertex(ix[i] as number, iy[i] as number, 1);
    }
    for (let i = 0; i < n; i++) this.vertex((xs[i] as number) - (nx[i] as number) * h, (ys[i] as number) - (ny[i] as number) * h, 0);
    // Convex (round rects, most UI shapes): a fan, no ear clipping.
    if (isConvex) for (let i = 1; i + 1 < n; i++) this.tri(base, base + i, base + i + 1);
    else earClip(ix, iy, n, (a, b, c) => this.tri(base + a, base + b, base + c));
    for (let i = 0; i < n; i++) {
      const j = i === n - 1 ? 0 : i + 1;
      this.quad(base + i, base + n + i, base + j, base + n + j);
    }
  }

  private stroke(n: number, closed: boolean, width: number, aa: number): void {
    if (n < 2) return;
    if (closed && n < 3) closed = false;
    const { xs, ys, nx, ny } = this;
    this.normals(n, closed);
    const half = width / 2;
    const hi = Math.max(half - aa / 2, 0);
    const ho = half + aa / 2;
    // Lines thinner than a pixel fade instead of shrinking below one.
    const core = Math.min(1, width / aa);
    const segments = closed ? n : n - 1;
    // Four vertices per point across the line: left edge, left core, right core, right edge.
    const base = this.reserve(4 * n, 18 * segments);
    for (let i = 0; i < n; i++) {
      const x = xs[i] as number;
      const y = ys[i] as number;
      const ax = nx[i] as number;
      const ay = ny[i] as number;
      this.vertex(x + ax * ho, y + ay * ho, 0);
      this.vertex(x + ax * hi, y + ay * hi, core);
      this.vertex(x - ax * hi, y - ay * hi, core);
      this.vertex(x - ax * ho, y - ay * ho, 0);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 4;
      const b = base + (i === n - 1 ? 0 : i + 1) * 4;
      this.quad(a, a + 1, b, b + 1);
      this.quad(a + 1, a + 2, b + 1, b + 2);
      this.quad(a + 2, a + 3, b + 2, b + 3);
    }
  }

  /** Room for `v` more vertices and `i` more indices; returns the first new vertex's index. */
  private reserve(v: number, i: number): number {
    if ((this.count + v) * 24 > this.data.byteLength) {
      const old = this.f32;
      this.data = new ArrayBuffer(2 ** Math.ceil(Math.log2((this.count + v) * 24)));
      this.f32 = new Float32Array(this.data);
      this.u32 = new Uint32Array(this.data);
      this.f32.set(old.subarray(0, this.count * 6));
    }
    if (this.icount + i > this.indices.length) {
      const old = this.indices;
      this.indices = new Uint32Array(2 ** Math.ceil(Math.log2(this.icount + i)));
      this.indices.set(old.subarray(0, this.icount));
    }
    return this.count;
  }

  /** Two triangles joining edge (a, b) to edge (c, d). */
  private quad(a: number, b: number, c: number, d: number): void {
    this.tri(a, b, c);
    this.tri(b, d, c);
  }

  private tri(a: number, b: number, c: number): void {
    const k = this.icount;
    this.indices[k] = a;
    this.indices[k + 1] = b;
    this.indices[k + 2] = c;
    this.icount = k + 3;
  }

  /** A textured quad: the unit square through `m`, sampling `u0, v0, u1, v1` from texture `unit`. */
  sprite(m: Matrix, u0: number, v0: number, u1: number, v1: number, color: number, flash: number, unit: number): void {
    const base = this.reserve(4, 6);
    const extra = 0xff | (Math.round(flash * 255) << 8) | (unit << 16);
    const { f32, u32 } = this;
    for (let c = 0; c < 4; c++) {
      const cx = c & 1;
      const cy = c >> 1;
      const f = (base + c) * 6;
      f32[f] = m[0] * cx + m[2] * cy + m[4];
      f32[f + 1] = m[1] * cx + m[3] * cy + m[5];
      f32[f + 2] = cx ? u1 : u0;
      f32[f + 3] = cy ? v1 : v0;
      u32[f + 4] = color;
      u32[f + 5] = extra;
    }
    this.count += 4;
    this.quad(base, base + 1, base + 2, base + 3);
  }

  private vertex(x: number, y: number, coverage: number): void {
    const m = this.m;
    const f = this.count * 6;
    this.f32[f] = m[0] * x + m[2] * y + m[4];
    this.f32[f + 1] = m[1] * x + m[3] * y + m[5];
    this.f32[f + 2] = 0;
    this.f32[f + 3] = 0;
    this.u32[f + 4] = this.color;
    // Coverage, no flash, and texture unit 255: none (the fragment stage reads white).
    this.u32[f + 5] = Math.round(coverage * 255) | (255 << 16);
    this.count++;
  }
}

/** Every turn the same way (or straight), for a polygon wound with positive area. */
function convex(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): boolean {
  for (let i = 0; i < n; i++) if (cross(xs, ys, i, (i + 1) % n, (i + 2) % n) < 0) return false;
  return true;
}

/** Reused by `earClip`, so filling shapes every frame doesn't allocate. */
const INDICES: number[] = [];

/**
 * Triangulate a simple polygon wound so its interior is on the left (positive signed area in y-down space).
 * O(n²), fine for UI and debug shapes. Self-intersecting input still produces triangles, just not exact ones.
 */
export function earClip(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number, tri: (a: number, b: number, c: number) => void): void {
  const idx = INDICES;
  idx.length = 0;
  for (let k = 0; k < n; k++) idx.push(k);
  let guard = 0;
  let i = 0;
  while (idx.length > 3 && guard < idx.length) {
    const len = idx.length;
    const a = idx[(i + len - 1) % len] as number;
    const b = idx[i % len] as number;
    const c = idx[(i + 1) % len] as number;
    if (isEar(xs, ys, idx, a, b, c)) {
      tri(a, b, c);
      idx.splice(i % len, 1);
      guard = 0;
    } else {
      i++;
      guard++;
    }
    i %= idx.length;
  }
  if (idx.length === 3) tri(idx[0] as number, idx[1] as number, idx[2] as number);
  // No ear left (degenerate or self-intersecting): fan the rest.
  else for (let k = 1; k + 1 < idx.length; k++) tri(idx[0] as number, idx[k] as number, idx[k + 1] as number);
}

function cross(xs: ArrayLike<number>, ys: ArrayLike<number>, a: number, b: number, c: number): number {
  const ax = xs[a] as number;
  const ay = ys[a] as number;
  return ((xs[b] as number) - ax) * ((ys[c] as number) - ay) - ((ys[b] as number) - ay) * ((xs[c] as number) - ax);
}

function isEar(xs: ArrayLike<number>, ys: ArrayLike<number>, idx: number[], a: number, b: number, c: number): boolean {
  if (cross(xs, ys, a, b, c) <= 0) return false;
  for (const p of idx) {
    if (p === a || p === b || p === c) continue;
    if (cross(xs, ys, a, b, p) >= 0 && cross(xs, ys, b, c, p) >= 0 && cross(xs, ys, c, a, p) >= 0) return false;
  }
  return true;
}
