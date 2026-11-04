# spryte

## 0.12.3

### Patch Changes

- ce6fe88: Warn once in development when `draw.sprites` gets `each.frame` frames from more than one image. Those copies draw one quad each instead of one instanced call, and before 0.12.3 nothing said so. Put the frames on one atlas to keep it one call.

## 0.12.2

### Patch Changes

- d43cd3d: Snap bitmap glyphs to whole logical pixels after scale and translation, matching pixel-art sprites on WebGL2 and Canvas 2D. Before 0.12.2, only local positions were rounded, so centred or right-aligned text could land between pixels under a fractional parent translation. Rotated and skewed text keeps its transformed positions.

## 0.12.1

### Patch Changes

- c9a0a2e: `draw.sprites` warns once per renderer when an array it gets is detached, which happens to a view of wasm memory after that memory grows. Before, it drew nothing with no message. The docs now say to recreate such views after growth or each frame.

## 0.12.0

### Minor Changes

- 3faf45c: New `mesh(draw, frame, vertices, uvs, indices?, options?)`: draw an image stretched over triangles you place, for trails, ropes, waving flags and bent sprites. UVs are in source pixels from the frame's top-left, so atlas frames work. On WebGL2 meshes join the shape batch (one draw call with the shapes and sprites around them), and a two-triangle mesh over a frame matches `draw.sprite` pixel for pixel. Canvas 2D clips and draws each triangle, which is slower and can show faint lines along shared edges. It's a separate import: 1.6 kB brotli for apps that use it (0.1 kB if they already draw shapes), 0.08 kB for apps that don't.
- 55660ca: New `mipmaps` option for `createRenderer`: build mip levels for every uploaded image, so smooth images drawn well below their size (zoomed-out maps, charts, thumbnails) stay steady instead of shimmering. Off by default; costs a third more GPU memory per image. Render targets, borrowed host textures and `smooth: false` draws are unaffected.

## 0.11.0

### Minor Changes

- b17a196: Static layers: `draw.record(fn)` keeps the sprites `fn` draws in a `Layer` without drawing them, and `draw.replay(layer)` draws them all again under the current transform. On WebGL2 a replay is one draw call per eight images, with the instances in a GPU buffer made once, so a tilemap or background costs no JavaScript per sprite. It puts the same pixels on screen as drawing the sprites one by one, pixel snapping included at fractional camera offsets and zoom (checked on a real GPU against direct drawing on both backends). `draw.alpha` applies at replay. On Canvas 2D, under a custom shader or `draw.alpha` below 1, replay draws the sprites one by one. After a context loss the layer's buffers are rebuilt; `layer.dispose()` frees them.

## 0.10.0

### Minor Changes

- e44fbbc: Custom shaders get `frameUv()`: the position inside the drawn frame, from (0, 0) at the top left to (1, 1) at the bottom right. `uv` stays in atlas space, so effects shaped to a sprite no longer need the frame's atlas rect passed as a uniform. `@debuffjp/core` now re-exports the `Shader` and `UniformValue` types.

## 0.9.0

### Minor Changes

- 0403e36: `drawElement` (experimental): draw a live DOM element (a menu, a text field, rich text) inside the canvas, through spryte's transforms and shaders, with Chrome's HTML-in-Canvas API (Chrome and Edge 157 and later). The element keeps clicks, focus, typing, text selection and screen readers where it's drawn. It returns false, drawing nothing, where the API is missing, so the element stays in the page. `canDrawElements()` reports support. Guide: https://debuff.jp/spryte/html-in-canvas

## 0.8.0

### Minor Changes

- cc3125d: New `gpuTimer(draw)`: GPU milliseconds for what you draw between its `begin()` and `end()`, to tell a GPU-bound frame from a CPU-bound one. Results arrive a few frames late and never block. `ms` stays `undefined` where timing isn't available (Canvas 2D, and browsers without `EXT_disjoint_timer_query_webgl2`, which in practice means everything but Chromium on desktop), after a GPU timing glitch, and when a host engine or profiler is already timing the frame. Separately imported, so it adds nothing unless used.
- c3669d4: `draw.sprites()` takes interleaved data. Set `each.stride` and `positions` becomes one record of `stride` floats per copy, uploaded to the GPU as is; `each.scale`, `rotation`, `color` and `frame` then take offsets into the record. `positions` must be a `Float32Array` and may view a `SharedArrayBuffer`, so a worker's buffer draws without a per-frame copy.
  
  `sprites()` inside `withShader` now stays one instanced draw instead of one quad per copy: the effect is compiled against the per-copy program. Only `source(uv)`, `color` and `uv` are guaranteed inside `effect` there. Frames across images still draw one quad per copy.

### Patch Changes

- 56749bb: Canvas 2D fallback: tinted sprites in more than 256 colours no longer slow to seconds per frame. The cache of recoloured copies used to clear completely at 256 entries, so animated or per-copy colours re-tinted nearly every sprite every frame; it now drops the least recently used entry and holds up to 1,024 per image. Repeating the last tint also skips the cache lookup. Output is unchanged. Measured in headless Chrome: 6,000 copies in 1,000 colours went from 2.2 s to 36 ms per frame, and 60,000 copies in one colour from 212 to about 180 ms.

## 0.7.3

### Patch Changes

- d929832: `draw.sprite()` is faster again on WebGL2: a sprite drawn under the same transform as the one before it now skips straight to writing its instance, instead of re-checking the transform, the texture and the batch. On 2dbench (RTX 5060 laptop, Chrome 155), the mixed scene at 50,000 sprites went from 5.8-6.0 ms to 4.1-5.0 ms and bunny from 5.2-6.0 ms to 4.1-4.7 ms, over two interleaved passes, with the same pixels. Scenes that don't use `draw.sprite` per sprite don't change. Startup JS grows by about 0.1 kB (brotli).

## 0.7.2

### Patch Changes

- 809a84c: `draw.sprite()` is faster on WebGL2: the vertex shader now does each sprite's rotation, scale and anchor maths, which spryte used to do in JavaScript. In 2dbench's mixed scene (rotation, scale, tint and alpha on every sprite), a 50,000-sprite frame went from 7.1 ms to 5.5 ms on an RTX 5060 laptop, with the same pixels. Unrotated pixel art is still rounded to whole pixels on the CPU, so it lands where it did. Sprites and other drawing (rects, text, shapes) still share one batch. The Canvas 2D fallback is unchanged. Startup code is about 0.7 kB larger (brotli).

## 0.7.1

### Patch Changes

- 36b1bee: Docs keep what changed: the ui README and JSDoc describe the squish default, `debuffFrame` and the lime bars as they were before 0.19, and spryte's docs say what 0.6 did before borrowed textures were looked up every frame.

## 0.7.0

### Minor Changes

- a5d8af2: `spryte/pixi`: draw with spryte inside a PixiJS v8 app through a `RenderContainer`, in Pixi's scene order, under its masks, filters and render textures, on Pixi's own WebGL2 context. Images Pixi has uploaded draw from Pixi's GPU textures and stay marked as used for Pixi's texture GC. Borrowed textures are now looked up again every frame, so a host that frees or re-creates one is never drawn stale.

## 0.6.0

### Minor Changes

- 209fc38: `spryteExtern` draws images Phaser already loaded from Phaser's own GPU textures, so a texture shared by both is no longer uploaded twice. `createSharedRenderer` takes a `borrow` option that lets any host engine lend its textures the same way.

## 0.5.1

### Patch Changes

- 70a00c9: npm homepage links to the package's page on debuff.jp.

## 0.5.0

### Minor Changes

- 7838cf8: `draw.sprites` takes a frame per copy: pass a `Frame[]` as the first argument and index it with `each.frame`. A belt of different items or a swarm at different animation phases is one draw call instead of one call per frame. Frames on one image draw instanced; frames across images fall back to one quad per copy. The Canvas 2D fallback and `withShader` take the same path as before.

## 0.4.3

### Patch Changes

- 927bbd0: Ten fixes from a review of the whole package:
  
  - `roundRect` lost its last corner at radii of about 18 device pixels or more: the point buffer was half the size it needed.
  - The text cache for strings that get their own canvas (the Canvas 2D fallback, and tall strings on WebGL2) grew without bound while text kept changing. It now holds at least 256 strings, plus whatever is on screen.
  - An image drawn before it finished loading stayed invisible: its 0×0 size and empty texture were cached for good. Both are now read again once it has loaded.
  - `draw.invalidate(src)` also forgets the source's size, so a resized canvas draws at its new size.
  - `mask()` and `filter()` inside `draw.clip()` on Canvas 2D leaked the clip's `save()` every frame, and on WebGL2 a filter's first pass was cleared only inside the clip, so its blur sampled stale pixels at the edges.
  - `into()`, `mask()` and `filter()` nested inside a mask or filter at a render scale other than 1 drew at the wrong scale: the outer size was taken in pixels instead of logical units.
  - `into()` with a translucent clear colour on WebGL2 cleared with straight alpha instead of premultiplied, so the colour came out too bright and differed from Canvas 2D.
  - A target the GPU refuses (too large, or an incomplete framebuffer) no longer leaves `into()`'s transform, clips, alpha and render scale changed.
  - Shared mode: a render target first drawn as an image (never drawn into) rebound the canvas instead of the host's framebuffer for the rest of the frame.

## 0.4.2

### Patch Changes

- dc56b3d: Republish of the shared-mode context-loss fix: 0.4.1 was published from a build made before it, so its `createSharedRenderer` still misses a loss restored between two frames. 0.4.2 carries the fix.

## 0.4.1

### Patch Changes

- 210ec36: Shared mode (`createSharedRenderer`, `spryte/phaser`): recover from a WebGL context loss that is restored before spryte's next frame. spryte polled `isContextLost()` at `begin()`, so a loss and restore between two frames went unnoticed and it kept using objects of the dead context. It now notes both events (without claiming them from the host) and rebuilds at the next `begin()`.

## 0.4.0

### Minor Changes

- 503e0df: spryte inside another engine. `createSharedRenderer(gl)` draws on a WebGL2 context the host owns, inside its frame and draw order: into the host's framebuffer, under its scissor and stencil, leaving its texture filtering alone. `spryte/phaser` wraps it for Phaser 4: `spryteExtern(extern, render)` draws in an `Extern`'s slot with Phaser's camera applied, and `createPhaserContext()` gives Phaser a WebGL2 context with its shaders translated to GLSL ES 3.00 (Phaser 4.2.1's `Gradient`, noise normal maps and `smoothPixelArt` don't compile on WebGL2 otherwise). Also `draw.transform(a, b, c, d, e, f)` multiplies a matrix onto the transform, and `draw.begin(null, ...)` draws over the previous frame instead of clearing.

## 0.3.0

### Minor Changes

- cff2aef: New blend modes: `multiply`, `screen` and `erase`, alongside `normal` and `add`. WebGL2 and Canvas 2D draw them identically over opaque pixels (checked on a real GPU).
- a5e021b: Filters: `filter(draw, filters, fn)` draws `fn` through a chain of ready-made effects: `blur()`, `grayscale()`, `sepia()`, `saturate()`, `hueRotate()`, `brightness()`, `contrast()`, `invert()` and `colorMatrix()`. Each is tree-shakeable. On Canvas 2D the named filters use the browser's CSS filters, which WebGL2 matches to within 2 levels per channel.
- a788f55: `mask(draw, shape, fn)`: keep what `fn` draws only where `shape` draws. The mask can be anything you can draw (sprites with soft alpha, shapes, text), it nests, and it works inside render targets. A rectangle mask is pixel-identical to `clip()` on both backends.
- d7ec5ea: `nineSlice(draw, …)` for UI panels that stretch without stretching their corners, and `tiled(draw, …)` for repeating fills (scrolling backgrounds, floors) that work on frames inside an atlas. Both are plain quads, so they batch with sprites, run through custom shaders and match on both backends.
- 6dff019: Shapes, masks, filters, `nineSlice` and `tiled` are standalone functions that take the `Draw` (`roundRect(draw, …)`, `mask(draw, shape, fn)`), so apps only ship what they use. spryte's startup JS is 11.3 kB brotli without them (a minimal app, `bench/size`).
- 1979a2e: Vector shapes: `polygon` (concave is fine), `polyline` (strokes with mitred joins), `roundRect` (filled or outlined) and `ring`. On WebGL2 they're tessellated on the CPU and antialiased with a one-pixel feathered edge, so they match Canvas 2D's antialiasing without MSAA, and they batch in draw order with sprites. Custom shaders (`withShader`) don't apply to shapes.

### Patch Changes

- b563010: `blur()` takes half the texture samples (two texels per tap through linear filtering) and reaches twice as far: blurs up to about 40 device pixels now match CSS `blur()`, instead of being cut short past 20.
- 885d45d: Canvas 2D fallback: browsers whose Canvas 2D ignores `ctx.filter` (Safari before 18) now warn once and draw unfiltered, detected with a one-pixel probe. GPU checks run in Firefox and WebKit too (`SPRYTE_BROWSER=firefox|webkit`).
- 5e31eeb: Shapes batch faster: indexed geometry and a fan for convex shapes (5,000 round rects: 39 ms to 17 ms on an AMD 780M laptop), and sprites drawn between shapes join the shape batch, so UI that alternates panels and icons is one draw call instead of one per switch (5,000 pairs: 50 ms to 18 ms).

## 0.2.3

### Patch Changes

- 30ff49d: `draw.circle` stays crisp at large sizes. It used to stretch one 64px texture to every radius, so big circles (and the rounded corners built from them) blurred, especially on high-DPI screens. It now picks a 64, 256 or 1024px texture by the circle's size on screen.

## 0.2.2

### Patch Changes

- 2e71515: README: particle frame-time chart and the raycaster result from 2dbench. Benchmarks doc: results across devices.
- 33d6a29: Text that changes often is much faster on WebGL2. `draw.text` with a CSS font now packs strings into shared atlas pages and uploads only each new string's rectangle, instead of creating a texture per string, so labels batch into one draw call. In 2dbench's text scene (1,000 labels, each changing every 8 frames) a frame drops from 10.4 ms to 2.7 ms on an RTX 5060 laptop; at 5,000 labels spryte (5.3 ms) is now ahead of Canvas 2D (9.8 ms) and PixiJS BitmapText (22.9 ms). Pixels are unchanged, and the Canvas 2D fallback keeps its per-string cache.

## 0.2.1

### Patch Changes

- 984a0eb: README: logo, what spryte is for beyond games, links to the guides and the PixiJS migration guide, and where to get help.

## 0.2.0

### Minor Changes

- 1ca1155: `createRenderer(canvas, { transparent: true })` makes a see-through canvas: clear with an alpha colour (`"#0000"`) to draw over the page or another renderer, such as particles over a PixiJS scene.

### Patch Changes

- 68dec64: Canvas 2D fallback: tint and flash on partly transparent pixels now match WebGL2 (they bled the raw tint colour in before). Tinted or flashed frames are recoloured once per source, frame, colour and flash and cached.
- 3d1f9e2: No more flicker on dual-GPU Windows laptops: spryte no longer asks for a desynchronized (low-latency) canvas, which Chrome presents unreliably there.
- 6bc9e5d: `draw.text`: the text cache no longer thrashes when a frame shows more than 256 distinct strings. It used to evict and re-rasterise strings still on screen every frame (155 ms a frame for 540 labels in 2dbench, 709 ms for 2,000). Now it never evicts a string drawn this frame or the last and grows to fit: 5.4 ms and 12.3 ms. Recovery after a lost WebGL context drops from 737 ms to 93 ms.

## 0.1.2

### Patch Changes

- 3a328dd: npm description and README lead with the measured result and link 2dbench.

## 0.1.1

### Patch Changes

- 247d5a4: Fixes from an adversarial QA pass: a shader that fails to compile no longer breaks the renderer; `draw.sprites` clamps `count` to the arrays it's given (it used to draw nothing on WebGL2 when `count` was too large); Canvas 2D keeps smoothing correct after a clip; oversized or fractional render targets throw clearly; using a disposed `Draw` throws. README and benchmark docs now use the interleaved, parity-gated results: 2–3.8× faster than PixiJS 8 like for like (0.1.0's README overstated several cases).
