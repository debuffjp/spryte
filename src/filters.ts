import type { Draw } from "./draw.js";
import { offscreen, pass, restore, whole } from "./offscreen.js";
import { Shader, type UniformValue } from "./shader.js";

/**
 * Run `fn` and draw the result through `filters`, in order. Same units, transform and clips as outside;
 * nests with masks and targets. Each filter pass is an offscreen pass the size of the destination, so filter
 * groups, not single sprites.
 *
 * ```ts
 * import { blur, filter, grayscale } from "spryte";
 * filter(draw, [grayscale()], () => drawWorld(draw)); // paused
 * draw.blend("add");
 * filter(draw, [blur(4)], () => drawLights(draw)); // glow: a blurred copy added under the sharp one
 * draw.blend("normal");
 * drawLights(draw);
 * ```
 */
export function filter(draw: Draw, filters: readonly Filter[], fn: () => void): void {
  if (filters.length === 0) {
    fn();
    return;
  }
  const o = offscreen(draw);
  let result = o.a;
  let css = "";
  try {
    pass(draw, o, o.a, fn, true);
    const scale = o.pw / o.lw;
    if (draw.backend.setFilter) {
      // Canvas 2D: the browser's own filters, applied as the result is drawn.
      css = filters
        .map((f) => f.css(scale) ?? "")
        .join(" ")
        .trim();
    } else {
      // Ping-pong between the two targets, one pass at a time.
      for (const f of filters)
        for (const p of f.passes) {
          const from = result;
          result = from === o.a ? o.b : o.a;
          pass(
            draw,
            o,
            result,
            () => {
              for (const [name, value] of p.uniforms(1 / o.pw, 1 / o.ph, scale)) p.shader.set(name, value);
              whole(draw, from, o, p.shader, p.smooth);
            },
            true,
          );
        }
    }
  } finally {
    restore(draw, o);
  }
  if (css) draw.backend.setFilter?.(css);
  whole(draw, result, o);
  if (css) draw.backend.setFilter?.("none");
}

/**
 * A ready-made effect for `filter(draw, filters, fn)`. Make them with `blur()`, `colorMatrix()`, `grayscale()`
 * and friends; they're plain values, cheap to create every frame.
 */
export interface Filter {
  /** @internal GPU passes, run in order. `scale` is destination pixels per logical unit. */
  readonly passes: readonly FilterPass[];
  /** @internal The Canvas 2D equivalent as a CSS filter function, or null where there's none. */
  css(scale: number): string | null;
}

/** @internal */
export interface FilterPass {
  shader: Shader;
  /** Sample the previous pass with linear filtering. */
  smooth?: boolean;
  uniforms(texelW: number, texelH: number, scale: number): [string, UniformValue][];
}

// Shared shaders, so filters made every frame never recompile. Samples outside the image are transparent,
// as in CSS filters.
let blurShader: Shader | undefined;
let matrixShader: Shader | undefined;

const BLUR = `
uniform vec2 dir;
uniform float sigma;
bool inside(vec2 uv) {
  return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
}
vec4 tap(vec2 uv) {
  return inside(uv) ? source(uv) : vec4(0.0);
}
// Texels i and i + 1 from uv along d, weighted k1 and k2, in one linear sample at f. At the image's edge only
// texel i is inside: sample it alone, since outside is transparent (clamping would repeat the edge texel).
vec4 pair(vec2 uv, vec2 d, float i, float k1, float k2, float f) {
  if (inside(uv + d * (i + 1.0))) return source(uv + d * f) * (k1 + k2);
  return tap(uv + d * i) * k1;
}
vec4 effect(vec4 color, vec2 uv) {
  // Out to 3 sigma, two texels per tap: linear filtering samples between texels i and i + 1 at the point
  // that weights them as the Gaussian does, halving the taps.
  float n = min(ceil(sigma * 3.0), 128.0);
  float s2 = 2.0 * sigma * sigma;
  vec4 sum = tap(uv);
  float total = 1.0;
  for (int j = 0; j < 64; j++) {
    float i = 1.0 + 2.0 * float(j);
    if (i > n) break;
    float k1 = exp(-i * i / s2);
    float k2 = exp(-(i + 1.0) * (i + 1.0) / s2);
    float k = k1 + k2;
    float f = (i * k1 + (i + 1.0) * k2) / k;
    sum += pair(uv, dir, i, k1, k2, f) + pair(uv, -dir, i, k1, k2, f);
    total += 2.0 * k;
  }
  return sum / total * color;
}`;

const MATRIX = `
uniform vec4 r;
uniform vec4 g;
uniform vec4 b;
uniform vec4 a;
uniform vec4 o;
vec4 effect(vec4 color, vec2 uv) {
  vec4 p = source(uv);
  vec4 c = p.a > 0.0 ? vec4(p.rgb / p.a, p.a) : vec4(0.0);
  vec4 q = clamp(vec4(dot(r, c), dot(g, c), dot(b, c), dot(a, c)) + o, 0.0, 1.0);
  return vec4(q.rgb * q.a, q.a) * color;
}`;

/**
 * Gaussian blur. `radius` is the standard deviation in logical units, the same as CSS `blur()`. Two passes of
 * up to 65 taps; blurs over about 40 device pixels are cut short, so blur a smaller target and scale it up instead.
 */
export function blur(radius: number): Filter {
  blurShader ??= new Shader(BLUR);
  const shader = blurShader;
  const pass = (x: number, y: number): FilterPass => ({
    shader,
    smooth: true,
    uniforms: (tw, th, scale) => [
      ["dir", [x * tw, y * th]],
      ["sigma", Math.max(radius * scale, 1e-3)],
    ],
  });
  return {
    passes: radius > 0 ? [pass(1, 0), pass(0, 1)] : [],
    css: (scale) => (radius > 0 ? `blur(${radius * scale}px)` : null),
  };
}

/**
 * Colour matrix: 20 numbers, four rows of `[r, g, b, a, offset]` (offset 0..1), applied to unpremultiplied
 * colour. WebGL2 only; on Canvas 2D this one draws unfiltered. The named filters below work on both.
 */
export function colorMatrix(m: readonly number[]): Filter {
  return matrix(m, null);
}

/** 0 (unchanged) to 1 (grey). CSS `grayscale()`. */
export function grayscale(amount = 1): Filter {
  const s = 1 - amount;
  return rgb(
    [0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s],
    [0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s],
    [0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s],
    `grayscale(${amount})`,
  );
}

/** 0 (unchanged) to 1 (full sepia). CSS `sepia()`. */
export function sepia(amount = 1): Filter {
  const s = 1 - amount;
  return rgb(
    [0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s],
    [0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s],
    [0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s],
    `sepia(${amount})`,
  );
}

/** 0 is grey, 1 unchanged, above 1 more vivid. CSS `saturate()`. */
export function saturate(amount: number): Filter {
  const s = amount;
  return rgb(
    [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
    [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
    `saturate(${amount})`,
  );
}

/** Rotate hues by `radians`. CSS `hue-rotate()`. */
export function hueRotate(radians: number): Filter {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return rgb(
    [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
    [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283],
    [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    `hue-rotate(${radians}rad)`,
  );
}

/** Multiply colour: 0 black, 1 unchanged. CSS `brightness()`. */
export function brightness(amount: number): Filter {
  return matrix([amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, 1, 0], `brightness(${amount})`);
}

/** 0 flat grey, 1 unchanged, above 1 more contrast. CSS `contrast()`. */
export function contrast(amount: number): Filter {
  const o = 0.5 - 0.5 * amount;
  return matrix([amount, 0, 0, 0, o, 0, amount, 0, 0, o, 0, 0, amount, 0, o, 0, 0, 0, 1, 0], `contrast(${amount})`);
}

/** 0 unchanged, 1 inverted. CSS `invert()`. */
export function invert(amount = 1): Filter {
  const k = 1 - 2 * amount;
  return matrix([k, 0, 0, 0, amount, 0, k, 0, 0, amount, 0, 0, k, 0, amount, 0, 0, 0, 1, 0], `invert(${amount})`);
}

function rgb(r: number[], g: number[], b: number[], css: string): Filter {
  return matrix([...r, 0, 0, ...g, 0, 0, ...b, 0, 0, 0, 0, 0, 1, 0], css);
}

function matrix(m: readonly number[], css: string | null): Filter {
  if (m.length !== 20) throw new Error(`spryte: a colour matrix has 20 numbers, got ${m.length}`);
  matrixShader ??= new Shader(MATRIX);
  const shader = matrixShader;
  const row = (i: number): UniformValue => [m[i] as number, m[i + 1] as number, m[i + 2] as number, m[i + 3] as number];
  const uniforms: [string, UniformValue][] = [
    ["r", row(0)],
    ["g", row(5)],
    ["b", row(10)],
    ["a", row(15)],
    ["o", [m[4] as number, m[9] as number, m[14] as number, m[19] as number]],
  ];
  return { passes: [{ shader, uniforms: () => uniforms }], css: () => css };
}
