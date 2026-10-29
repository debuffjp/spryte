import type { Matrix } from "./backend.js";
import type { Frame } from "./draw.js";

/** Optional per-copy values for `draw.sprites`. Each array has one entry per copy. */
export interface SpritesEach {
  /** Uniform scale per copy, multiplied with `scaleX`/`scaleY`. */
  scale?: ArrayLike<number>;
  /** Radians per copy, added to `rotation`. */
  rotation?: ArrayLike<number>;
  /** `0xRRGGBBAA` per copy, multiplied with `tint` and `alpha`. A `Uint32Array`, uploaded as is. */
  color?: Uint32Array;
  /**
   * Frame per copy: an index into the `Frame[]` passed as `draw.sprites`' first argument (an index past the
   * end throws). Frames on one image stay one draw call; frames across images draw one quad per copy.
   */
  frame?: ArrayLike<number>;
}

/**
 * Everything a backend needs to draw copies of one frame with per-copy values.
 * @internal
 */
export interface CopySpec {
  /** The current transform. */
  m: Matrix;
  positions: ArrayLike<number>;
  count: number;
  /** The shared frame, or the first of `frames` (its image is the batch's texture). */
  frame: Frame;
  /** Anchor as a fraction of each copy's frame size. */
  originX: number;
  originY: number;
  /** Per-copy frames (`each.frame` indexes `frames`); `mixed` when they span more than one image. */
  frames: readonly Frame[] | undefined;
  mixed: boolean;
  /** Shared scale, flips folded in. */
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** Shared 0xRRGGBBAA (tint × alpha × global alpha). */
  color: number;
  flash: number;
  smooth: boolean;
  /** Pixel art under a rotation-free transform: copies whose own rotation is zero snap to whole pixels. */
  snap: boolean;
  each: SpritesEach;
}

/** Copy `i`'s frame: the shared one, or its entry in `frames`. */
export function frameAt(c: CopySpec, i: number): Frame {
  const frames = c.frames;
  const idx = c.each.frame;
  if (!frames || !idx) return c.frame;
  const f = frames[idx[i] as number];
  if (!f) throw new RangeError(`draw.sprites: each.frame[${i}] is ${idx[i]}, but ${frames.length} frames were passed`);
  return f;
}

/**
 * The quad matrix for one sprite (`draw.sprite`'s algebra): the unit square onto a `w × h` frame at `x, y` under
 * `m`, anchored at `ox, oy` (fractions of the frame), scaled by `sx, sy` and rotated by `r` radians. Writes `out`.
 */
export function placeAt(
  m: Matrix,
  w: number,
  h: number,
  x: number,
  y: number,
  ox: number,
  oy: number,
  sx: number,
  sy: number,
  r: number,
  out: Matrix,
): void {
  let a = sx;
  let b = 0;
  let c = 0;
  let d = sy;
  if (r) {
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    a = cos * sx;
    b = sin * sx;
    c = -sin * sy;
    d = cos * sy;
  }
  const px = -ox * w;
  const py = -oy * h;
  const lx = a * px + c * py + x;
  const ly = b * px + d * py + y;
  out[0] = (m[0] * a + m[2] * b) * w;
  out[1] = (m[1] * a + m[3] * b) * w;
  out[2] = (m[0] * c + m[2] * d) * h;
  out[3] = (m[1] * c + m[3] * d) * h;
  out[4] = m[0] * lx + m[2] * ly + m[4];
  out[5] = m[1] * lx + m[3] * ly + m[5];
}

/**
 * Copy `i`'s quad matrix (the same algebra as `draw.sprite`) and colour, for backends without a GPU path.
 * Returns the colour; writes the matrix into `out`.
 */
export function copyAt(c: CopySpec, i: number, out: Matrix, f: Frame): number {
  const k = c.each.scale ? (c.each.scale[i] as number) : 1;
  const r = c.rotation + (c.each.rotation ? (c.each.rotation[i] as number) : 0);
  placeAt(
    c.m,
    f.w,
    f.h,
    c.positions[i * 2] as number,
    c.positions[i * 2 + 1] as number,
    c.originX,
    c.originY,
    c.scaleX * k,
    c.scaleY * k,
    r,
    out,
  );
  if (c.snap && !r) {
    out[4] = Math.round(out[4]);
    out[5] = Math.round(out[5]);
  }
  const each = c.each.color ? (c.each.color[i] as number) : 0xffffffff;
  return each === 0xffffffff ? c.color : multiply(c.color, each);
}

/** Channel-wise product of two 0xRRGGBBAA colours. */
function multiply(x: number, y: number): number {
  const ch = (shift: number) => Math.round((((x >>> shift) & 0xff) * ((y >>> shift) & 0xff)) / 255);
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
