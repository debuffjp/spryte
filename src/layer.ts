import type { Matrix } from "./backend.js";
import type { Frame, SpriteDrawOptions } from "./draw.js";

/** @internal One recorded `draw.sprite` call, in the layer's own space. */
export interface LayerItem {
  frame: Frame;
  x: number;
  y: number;
  /** The call's options with `smooth` filled in, as `draw.sprite` would have read them. */
  o: SpriteDrawOptions;
  /** The transform inside `record()` when it was drawn (identity unless the callback moved it). */
  m: Matrix;
  /** Tint and per-sprite alpha as RGBA, without `draw.alpha`, which applies at replay. */
  color: number;
}

/**
 * Sprites recorded once with `draw.record()` and drawn again with `draw.replay()`, for things that don't
 * change from frame to frame: a tilemap, a background, a level's scenery. On WebGL2 a replay is a few draw
 * calls however many sprites the layer holds, instead of the per-sprite work of drawing them again.
 *
 * A layer keeps the sprite images it was recorded with. Change a tile, and record the layer again.
 */
export class Layer {
  /** @internal */
  readonly items: readonly LayerItem[];
  private readonly releases: (() => void)[] = [];

  /** @internal */
  constructor(items: readonly LayerItem[]) {
    this.items = items;
  }

  /** How many sprites it draws. */
  get size(): number {
    return this.items.length;
  }

  /** @internal A backend's GPU copy registers how to free itself. */
  onDispose(release: () => void): void {
    this.releases.push(release);
  }

  /** Free its GPU buffers. Replaying it afterwards builds them again. */
  dispose(): void {
    for (const release of this.releases.splice(0)) release();
  }
}
