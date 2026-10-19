/** A uniform value: a float, or a vec2/vec3/vec4 as an array. */
export type UniformValue =
  | number
  | readonly [number, number]
  | readonly [number, number, number]
  | readonly [number, number, number, number];

/**
 * A custom fragment effect, applied to everything drawn inside `draw.withShader(shader, fn)`.
 *
 * The source defines `vec4 effect(vec4 color, vec2 uv)`, which returns the pixel's colour. `color` is the
 * draw's tint and alpha, premultiplied. `source(uv)` samples the image being drawn. Declare your own uniforms
 * and set them with `set()`. Return premultiplied colour (rgb already multiplied by alpha).
 *
 * ```ts
 * const wave = draw.createShader(`
 *   uniform float time;
 *   vec4 effect(vec4 color, vec2 uv) {
 *     uv.x += sin(uv.y * 40.0 + time * 6.0) * 0.01;
 *     return source(uv) * color;
 *   }
 * `);
 * wave.set("time", t);
 * draw.withShader(wave, () => draw.sprite(hero, x, y));
 * ```
 *
 * WebGL2 only. On the Canvas 2D fallback, drawing inside `withShader` happens without the effect (warned once).
 */
export class Shader {
  /** @internal Uniform values by name. */
  readonly uniforms = new Map<string, UniformValue>();
  /** @internal Called when a uniform changes, so pending draws flush with the old value first. */
  onChange: (() => void) | undefined;

  constructor(readonly source: string) {
    if (!/\bvec4\s+effect\s*\(/.test(source)) throw new Error("spryte: a shader must define `vec4 effect(vec4 color, vec2 uv)`");
  }

  /** Set a uniform declared in the source. Applies to draws made after this call. */
  set(name: string, value: UniformValue): this {
    this.onChange?.();
    this.uniforms.set(name, value);
    return this;
  }
}
