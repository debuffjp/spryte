import type { Draw } from "./draw.js";
import { offscreen, pass, restore, whole } from "./offscreen.js";

/**
 * Run `fn`, keeping what it draws only where `shape` draws: a sprite (soft, using its alpha), shapes, text,
 * anything. Same units, transform and clips as outside. Nests, and works inside `draw.into()`. Costs two
 * offscreen passes the size of the destination, so mask a group of things at once rather than each sprite.
 *
 * ```ts
 * import { mask } from "spryte";
 * mask(draw, () => draw.circle(px, py, 40, "#fff"), () => drawLevel(draw)); // spotlight
 * ```
 */
export function mask(draw: Draw, shape: () => void, fn: () => void): void {
  const o = offscreen(draw);
  try {
    pass(draw, o, o.a, fn, true);
    draw.alpha = 1;
    pass(draw, o, o.b, shape, true);
    // Keep content where the shape drew: one quad over the whole target, so both backends agree.
    pass(
      draw,
      o,
      o.a,
      () => {
        draw.backend.setBlend("mask");
        whole(draw, o.b, o);
      },
      false,
    );
  } finally {
    restore(draw, o);
  }
  whole(draw, o.a, o);
}
