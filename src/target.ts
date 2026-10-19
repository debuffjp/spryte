/**
 * An offscreen image you draw into with `draw.into(target, fn)` and then draw like any image:
 * post-processing, cached static layers, minimaps, trails. Size is in pixels.
 *
 * On WebGL2 the contents live on the GPU and are lost if the context is lost: redraw them when
 * `draw.contextLost` turns false again, or redraw every frame.
 */
export class RenderTarget {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0))
      throw new Error(`spryte: render target size must be positive whole pixels, got ${width}×${height}`);
  }
}
