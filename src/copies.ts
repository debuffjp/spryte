import type { Matrix } from "./backend.js";
import type { Frame } from "./draw.js";

/**
 * Optional per-copy values for `draw.sprites`. Each array has one entry per copy.
 *
 * Interleaved data: set `stride` and `positions` becomes one record of `stride` floats per copy (a
 * `Float32Array`, which may view a `SharedArrayBuffer`). The fields then take offsets into the record instead
 * of arrays, and the record goes to the GPU as is, with no per-copy work:
 *
 * ```ts
 * // [x, y, scale, colour bits] per copy; write colours through a Uint32Array view of the same buffer.
 * draw.sprites(dot, data, n, {}, { stride: 4, scale: 2, color: 3 });
 * ```
 */
export interface SpritesEach {
  /** Floats per copy in `positions`, for interleaved data. Without it, `positions` is x, y pairs. */
  stride?: number;
  /** With `stride`: offset of x in each record (y follows). Default 0. */
  position?: number;
  /** Uniform scale per copy, multiplied with `scaleX`/`scaleY`. With `stride`, an offset into each record. */
  scale?: ArrayLike<number> | number;
  /** Radians per copy, added to `rotation`. With `stride`, an offset into each record. */
  rotation?: ArrayLike<number> | number;
  /**
   * `0xRRGGBBAA` per copy, multiplied with `tint` and `alpha`. A `Uint32Array`, uploaded as is. With `stride`, an
   * offset into each record whose bits are read as a `Uint32` (write it through a `Uint32Array` on the same buffer).
   */
  color?: Uint32Array | number;
  /**
   * Frame per copy: an index into the `Frame[]` passed as `draw.sprites`' first argument (an index past the
   * end throws). Frames on one image stay one draw call; frames across images draw one quad per copy.
   * With `stride`, an offset into each record.
   */
  frame?: ArrayLike<number> | number;
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
  /** Floats per copy in `positions` (2 unless `each.stride`) and the offset of x in each. */
  stride: number;
  offset: number;
  /** `positions`' bits as Uint32, when `each.color` is an offset into interleaved records. */
  bits: Uint32Array | undefined;
}

/** Copy `i`'s value of a per-copy field: an array entry, or a float at that offset in its interleaved record. */
export function valueAt(c: CopySpec, field: ArrayLike<number> | number, i: number): number {
  return (typeof field === "number" ? c.positions[i * c.stride + field] : field[i]) as number;
}

/** Copy `i`'s frame: the shared one, or its entry in `frames`. */
export function frameAt(c: CopySpec, i: number): Frame {
  const frames = c.frames;
  const idx = c.each.frame;
  if (!frames || idx === undefined) return c.frame;
  const k = valueAt(c, idx, i);
  const f = frames[k];
  if (!f) throw new RangeError(`draw.sprites: each.frame[${i}] is ${k}, but ${frames.length} frames were passed`);
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
  const e = c.each;
  const k = e.scale === undefined ? 1 : valueAt(c, e.scale, i);
  const r = c.rotation + (e.rotation === undefined ? 0 : valueAt(c, e.rotation, i));
  const p = i * c.stride + c.offset;
  placeAt(c.m, f.w, f.h, c.positions[p] as number, c.positions[p + 1] as number, c.originX, c.originY, c.scaleX * k, c.scaleY * k, r, out);
  if (c.snap && !r) {
    out[4] = Math.round(out[4]);
    out[5] = Math.round(out[5]);
  }
  const color = e.color;
  const each =
    color === undefined
      ? 0xffffffff
      : typeof color === "number"
        ? ((c.bits as Uint32Array)[i * c.stride + color] as number)
        : (color[i] as number);
  return each === 0xffffffff ? c.color : multiply(c.color, each);
}

/** Channel-wise product of two 0xRRGGBBAA colours. */
function multiply(x: number, y: number): number {
  const ch = (shift: number) => Math.round((((x >>> shift) & 0xff) * ((y >>> shift) & 0xff)) / 255);
  return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
