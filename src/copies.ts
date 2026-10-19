import type { Matrix, TextureSource } from "./backend.js";

/** Optional per-copy values for `draw.sprites`. Each array has one entry per copy. */
export interface SpritesEach {
  /** Uniform scale per copy, multiplied with `scaleX`/`scaleY`. */
  scale?: ArrayLike<number>;
  /** Radians per copy, added to `rotation`. */
  rotation?: ArrayLike<number>;
  /** `0xRRGGBBAA` per copy, multiplied with `tint` and `alpha`. A `Uint32Array`, uploaded as is. */
  color?: Uint32Array;
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
  src: TextureSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Anchor offset in frame pixels: -origin × size. */
  ox: number;
  oy: number;
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

/**
 * Copy `i`'s quad matrix (the same algebra as `draw.sprite`) and colour, for backends without a GPU path.
 * Returns the colour; writes the matrix into `out`.
 */
export function copyAt(c: CopySpec, i: number, out: Matrix): number {
  const k = c.each.scale ? (c.each.scale[i] as number) : 1;
  const r = c.rotation + (c.each.rotation ? (c.each.rotation[i] as number) : 0);
  const sx = c.scaleX * k;
  const sy = c.scaleY * k;
  let a = sx;
  let b = 0;
  let cc = 0;
  let d = sy;
  if (r) {
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    a = cos * sx;
    b = sin * sx;
    cc = -sin * sy;
    d = cos * sy;
  }
  const lx = a * c.ox + cc * c.oy + (c.positions[i * 2] as number);
  const ly = b * c.ox + d * c.oy + (c.positions[i * 2 + 1] as number);
  const m = c.m;
  out[0] = (m[0] * a + m[2] * b) * c.sw;
  out[1] = (m[1] * a + m[3] * b) * c.sw;
  out[2] = (m[0] * cc + m[2] * d) * c.sh;
  out[3] = (m[1] * cc + m[3] * d) * c.sh;
  out[4] = m[0] * lx + m[2] * ly + m[4];
  out[5] = m[1] * lx + m[3] * ly + m[5];
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
