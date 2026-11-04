import type { TextureSource } from "./backend.js";
import type { Draw, Frame } from "./draw.js";
import type { PanelDrawOptions } from "./panels.js";
import { ShapeBuffer } from "./shapes.js";

const NONE: PanelDrawOptions = Object.freeze({});

/**
 * Draw an image stretched over triangles: trails, ropes, flags, jelly and other deformed sprites.
 *
 * `vertices` are `x, y` pairs in the current transform's units, and `uvs` are matching `u, v` pairs in source
 * pixels from the frame's top-left, so an atlas frame works like a whole image. `indices` lists three vertices
 * per triangle; without it, every three vertices make one. Typed arrays work and can be reused every frame.
 *
 * On WebGL2 a mesh joins the shape batch, so meshes, shapes and the sprites drawn after them stay one draw call.
 * Custom shaders don't apply to meshes. Canvas 2D clips and draws each triangle on its own: slower, and edges
 * shared between triangles can show faint seams.
 *
 * ```ts
 * import { mesh } from "spryte";
 * // A 32×32 image bent into a trapezoid.
 * mesh(draw, image, [0, 0, 32, 0, -8, 32, 40, 32], [0, 0, 32, 0, 0, 32, 32, 32], [0, 1, 2, 1, 3, 2]);
 * ```
 */
export function mesh(
  draw: Draw,
  frame: Frame | TextureSource,
  vertices: ArrayLike<number>,
  uvs: ArrayLike<number>,
  indices?: ArrayLike<number> | null,
  o: PanelDrawOptions = NONE,
): void {
  const n = vertices.length >> 1;
  if (uvs.length < n * 2) throw new Error(`spryte: mesh has ${n} vertices but ${uvs.length >> 1} uvs`);
  const icount = indices ? indices.length - (indices.length % 3) : n - (n % 3);
  if (icount === 0) return;
  const f = "image" in frame ? frame : draw.wholeImage(frame);
  draw.quads++;
  draw.backend.mesh(
    draw.m,
    f.image,
    f.x,
    f.y,
    f.w,
    f.h,
    vertices,
    uvs,
    indices ?? null,
    icount,
    draw.spriteColor(o),
    o.flash ?? 0,
    o.smooth ?? draw.smooth,
    ShapeBuffer,
  );
}
