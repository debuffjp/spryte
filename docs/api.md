# spryte API

Everything is exported from `spryte`. Units are **logical**: you choose them in `begin()`, and spryte maps them onto the canvas's backing pixels.

## createRenderer(canvas, options?) → Draw

| Option | Default | |
| --- | --- | --- |
| `backend` | `"auto"` | `"auto"`: WebGL2, falling back to Canvas 2D. `"webgl2"`: throws if WebGL2 is unavailable. `"2d"`: always Canvas 2D. |
| `smooth` | `true` | Default image filtering. Use `false` for pixel art. Can be overridden per sprite. |
| `transparent` | `false` | See-through canvas: clear with an alpha colour (`"#0000"`) to draw over the page or another canvas, such as particles over a PixiJS scene. Opaque is slightly cheaper for the compositor. |

The Canvas 2D backend is a separate chunk, loaded only on fallback. Until it arrives (a few milliseconds), frames draw nothing.

## Frame lifecycle

```ts
draw.resize(canvas.width, canvas.height); // after you change the canvas's backing size
draw.begin(clear, width, height, scale);  // clear colour, logical size, backing pixels per logical unit
// ...draw calls, in paint order...
draw.end();                               // submits the frame
draw.dispose();                           // frees GPU objects and listeners; the Draw is unusable after
```

`scale` is usually `canvas.width / width` (CSS scale times `devicePixelRatio`). It also sets the resolution that text is rasterised at. A `clear` of `null` draws over what's already there: an overlay, a second pass, or a frame another engine began.

## Drawing

| Method | |
| --- | --- |
| `rect(x, y, w, h, color)` | Filled rectangle. |
| `circle(x, y, r, color)` | Filled, antialiased circle. |
| `line(x1, y1, x2, y2, width, color)` | Drawn as a rotated rectangle. |
| `sprite(frameOrImage, x, y, options?)` | Image or `Frame` (`{ image, x, y, w, h }`), anchored at `origin` (default centre). Options: `origin`, `scaleX`, `scaleY`, `rotation` (radians), `flipX`, `flipY`, `alpha`, `tint`, `flash` (0-1 toward white), `smooth`. **Doesn't allocate:** reuse one options object in hot loops. |
| `sprites(frame, positions, count?, options?, each?)` | One frame at many positions: particles, bullets, swarms. `positions` is x, y pairs. On WebGL2, a reused `Float32Array` is uploaded to the GPU as is, with **no JavaScript work per copy**. Other array types are copied into a staging array first, and inside `withShader` and on the Canvas 2D fallback each copy is drawn as its own quad. `options` apply to every copy. `each` adds per-copy values: `scale` (Float32Array), `rotation` (Float32Array, radians) `color` (Uint32Array of `0xRRGGBBAA`, multiplied with the tint) and `frame` (an index per copy into the `Frame[]` passed as the first argument, for a belt of different items or an animation at different phases). Scale, rotation and colour are uploaded as is; `frame` is expanded into a uv and size per copy. Frames on one image stay one draw call; frames across images fall back to one quad per copy. `count` is clamped to the shortest array, and a `NaN` or negative count draws nothing. The output is pixel-identical to a `sprite()` loop with the same values, including pixel snapping (checked on a real GPU by `npm run test:browser`). It's one draw call on WebGL2 and breaks the current batch. |
| `text(text, x, y, options?)` | `font` (CSS string or `BitmapFont`), `color`, `align`, `baseline`, `alpha`. CSS text is rasterised once and cached (LRU, 256 entries). |
| `measure(text, font?)` | Logical `{ w, h }` that `text()` fills. |

**Colours** are CSS hex strings (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), numbers `0xRRGGBBAA`, or any CSS colour (resolved once through a canvas, then cached).

## State

| | |
| --- | --- |
| `push()`, `pop()`, `translate(x, y)`, `scale(x, y?)`, `rotate(rad)` | Transform stack. `begin()` resets it. |
| `transform(a, b, c, d, e, f)` | Multiply a matrix (Canvas order: x' = a·x + c·y + e, y' = b·x + d·y + f) onto the transform: a camera or parent transform from another engine, skew included. |
| `clip(x, y, w, h, fn)` | Draws inside `fn` are clipped to the rectangle's screen bounds. Nested clips intersect. |
| `withCamera(camera, fn)` | Applies `camera.view()` (any `{ view(): Matrix }`) for the draws inside `fn`. |
| `blend(mode)` | `"normal"`, `"add"` (glow), `"multiply"` (shadows, tinted light), `"screen"` (soft lightening) or `"erase"` (cut alpha out, e.g. holes in a render target). Pixel-identical on WebGL2 and Canvas 2D over opaque pixels. Erase in render targets or on a `transparent` canvas: what an erased opaque canvas shows is up to the browser. |
| `alpha` | Global alpha multiplier. |
| `smooth` | Default filtering. |
| `font` | Default font: a CSS string, a `BitmapFont`, or a function returning one (evaluated lazily). |
| `invalidate(image)` | Re-upload an image whose pixels changed. |

### Optional features

Imported functions that take the `Draw`, so an app only ships the ones it uses (startup stays at spryte's core size otherwise):

```ts
import { blur, filter, mask, nineSlice, roundRect } from "spryte";
roundRect(draw, 8, 8, 120, 40, 6, "#222c");
```

| Function | Notes |
| --- | --- |
| `polygon(draw, points, color, count?)` | Filled, antialiased polygon through `[x0, y0, x1, y1, …]`. Concave is fine; it shouldn't cross itself. |
| `polyline(draw, points, width, color, closed?, count?)` | Antialiased line through the points, mitred joins, flat ends. Lines under a pixel fade rather than vanish. |
| `roundRect(draw, x, y, w, h, radius, color, lineWidth?)` | Rounded rectangle, filled or (with `lineWidth`) outlined. |
| `ring(draw, x, y, radius, width, color)` | Circle outline. |
| `nineSlice(draw, frame, x, y, w, h, insets, options?)` | UI panel: corners keep their size (`insets` in source pixels, one number or `[l, t, r, b]`), edges and centre stretch. Nine quads. Options: `tint`, `alpha`, `flash`, `smooth`. |
| `tiled(draw, frame, x, y, w, h, options?)` | Fill a box with a repeating frame (works inside atlases). Options add `offsetX`, `offsetY` (scroll, wraps) and `scale`. One quad per visible tile. |
| `mask(draw, shape, fn)` | Keep what `fn` draws only where `shape` draws (soft edges use the shape's alpha). Same units, transform and clips as outside; nests; works inside `into()`. Two offscreen passes at the destination's size, so mask groups, not single sprites. |
| `filter(draw, filters, fn)` | Draw `fn` through filters in order: `blur(radius)`, `grayscale()`, `sepia()`, `saturate()`, `hueRotate()`, `brightness()`, `contrast()`, `invert()` (all on both backends, matching CSS filters) and `colorMatrix(m)` (WebGL2 only). Glow: blur an additive copy, then draw the sharp one. On the Canvas 2D fallback, filters use `ctx.filter`: browsers that ignore it (Safari before 18) draw unfiltered, with a warning. |

## Render targets

Offscreen images you draw into, then draw like any image: post-processing, glow, cached static layers, minimaps, trails.

```ts
const glow = draw.createTarget(160, 90);              // pixels
draw.into(glow, () => {                               // inside: target pixels, fresh transform and clips
  draw.sprites(spark, sparks, n, { tint: "#ffd36b" });
});                                                   // clear: transparent by default; null keeps contents
draw.blend("add");
draw.sprite(glow, 0, 0, { origin: [0, 0], scaleX: 2, scaleY: 2, smooth: true });
draw.disposeTarget(glow);                             // when you're done with it
```

- `into()` nests, and restores the outer transform, clips, alpha and destination afterwards, even if `fn` throws. The **blend mode and an active `withShader` are not reset**: they apply inside the target and stay as `fn` left them (`begin()` resets both each frame).
- Drawing a target into itself, disposing it while you're drawing into it, or making it larger than the GPU's `MAX_TEXTURE_SIZE` throws. Sizes must be whole pixels.
- Targets work on both backends. A real-GPU check confirms that drawing into a target and then drawing the target 1:1 gives the same pixels as drawing directly (`npm run test:browser`).
- After a WebGL context loss, target contents are blank (GPU memory is gone). Check `draw.contextLost`, or redraw targets each frame.

## Shaders

A custom fragment effect for everything drawn inside a scope: dissolves, outlines, palette swaps, water, CRT. WebGL2 only. On the Canvas 2D fallback, the draws happen without the effect, with one console warning.

```ts
const wave = draw.createShader(`
  uniform float time;
  vec4 effect(vec4 color, vec2 uv) {      // return the pixel; premultiplied colour
    uv.x += sin(uv.y * 40.0 + time * 6.0) * 0.01;
    return source(uv) * color;            // source(uv) samples the image being drawn
  }
`);
wave.set("time", t);                      // float, or [x, y], [x, y, z], [x, y, z, w]
draw.withShader(wave, () => draw.sprite(hero, x, y));
```

- `color` is the draw's tint times alpha, premultiplied. Flash is applied after your effect.
- Shaders compile on first use. Errors throw with the driver's message, and line numbers refer to your source. A shader that fails to compile leaves the renderer as it was, and using it again throws again.
- `set()` affects only draws made after it, even inside the same scope.
- Shaders compose with render targets: draw into a target, then draw the target through a shader for full-screen post-processing.
- `sprites()` inside `withShader` falls back to one quad per copy, which is correct but without the bulk speed-up.

## Inside another engine: createSharedRenderer(gl, options?)

spryte on a WebGL2 context another engine owns, to draw the heaviest parts of a frame (bullets, particles) inside that engine's frame and draw order, on one GPU context with no overlay canvas. `options` has `smooth` and `borrow`. It returns `{ draw, target(framebuffer, width, height) }`.

```ts
const shared = createSharedRenderer(gl);        // inside the host's slot for foreign drawing: creation changes GL state
// each frame, in that slot:
shared.target(hostFramebuffer, width, height);  // if the host's destination changed (null: the canvas)
shared.draw.begin(null, width, height, 1);      // null: draw over the host's frame
shared.draw.transform(a, b, c, d, e, f);        // the host's camera
shared.draw.sprites(bullet, positions, count);
shared.draw.end();
```

- At `begin()` spryte binds its own program, vertex array and blend state, and resets depth test, face culling, colour mask and `UNPACK_FLIP_Y`. It keeps the host's scissor and stencil, so a camera viewport or mask applies to spryte too, and its own `clip()` intersects the host's scissor. At `end()` it gives the host's scissor back and unbinds sampler objects, which would otherwise override the texture filtering of a host written for WebGL1. It does not restore the host's program, vertex array, texture bindings or viewport: the host must rebind what it needs after the slot, as engines with cached GL state do (Phaser does).
- Context loss belongs to the host: it must `preventDefault` on `webglcontextlost` for the browser to restore the context. spryte listens to both events without claiming them, draws nothing while lost, and rebuilds its GPU objects at the first `begin()` after the restore, inside the host's slot, even when the loss and restore both happened between two frames.
- `borrow(image)` lends spryte the host's own GPU texture for an image, so a texture both draw isn't uploaded twice. Return `{ texture, width, height, flipY }`, or null for spryte to upload its own copy. spryte asks once per image per frame, so a texture the host frees or re-creates is never drawn stale; keep it cheap. (Added in 0.6, where it was asked once per image and the answer kept; from 0.7 it is asked every frame.) The texture must hold premultiplied alpha. spryte never writes to or deletes it. `spryte/phaser` and `spryte/pixi` set it up for you.
- The separate export costs nothing in apps that don't use it, and an app that only uses it never loads the Canvas 2D fallback.

### Phaser 4: `spryte/phaser`

```ts
import { createPhaserContext, spryteExtern } from "spryte/phaser";

const game = new Phaser.Game({ type: Phaser.WEBGL, ...createPhaserContext(), scene: Bullets });
class Bullets extends Phaser.Scene {
  create() {
    const extern = this.add.extern().setDepth(5); // spryte draws at this depth
    spryteExtern(extern, (draw) => draw.sprites(bullet, positions, count));
  }
}
```

| Function | |
| --- | --- |
| `createPhaserContext(canvas?, attributes?)` | A WebGL2 context for Phaser to run on (Phaser makes WebGL1 by itself), with `shimShaders` installed. Spread the result (`canvas`, `context`) into the game config. `attributes` default to Phaser's: opaque, antialiased, premultiplied, with a stencil buffer. |
| `spryteExtern(extern, render, options?)` | `render(draw)` runs each frame in the Extern's slot, with the Extern's `calcMatrix` (camera and any Container) applied, so coordinates are Phaser's world. Filters on the Extern or camera, camera viewports and `Stencil` masks apply. Returns `{ draw, dispose }`; `draw` exists from the first frame on, and `dispose` runs when the Extern is destroyed. |
| `shimShaders(gl)` | Translates Phaser's GLSL ES 1.00 shaders to ES 3.00 as they compile. Without it, on a WebGL2 context Phaser 4.2.1's `Gradient`, noise objects with `noiseNormalMap` and `smoothPixelArt` fail to compile, since `OES_standard_derivatives` is a WebGL1 extension. Your own ES 1.00 shaders go through it too; ones that declare `#version 300 es` pass through. |

Images Phaser loaded draw from Phaser's own GPU textures: pass `this.textures.get(key).getSourceImage()`. From spryte 0.6; earlier versions upload their own copy of every image.

Tested with Phaser 4.2.1 (`npm run test:phaser` runs the example's real-GPU checks). Phaser 3 has an `Extern` with a different callback and state handling; it isn't supported.

### PixiJS v8: `spryte/pixi`

```ts
import { RenderContainer } from "pixi.js";
import { spryteContainer } from "spryte/pixi";

// spryte draws where the container sits in the scene: over what's added before it, under what's added after.
app.stage.addChild(spryteContainer(new RenderContainer({}), (draw) => draw.sprites(bullet, positions, count)));
```

| Function | |
| --- | --- |
| `spryteContainer(container, render, options?)` | `render(draw)` runs each frame in the `RenderContainer`'s slot, in the container's local coordinates: its transform, its parents' and its render group's apply. Masks, render textures and filters apply; a `RenderContainer` has no bounds, so give a filtered container a `filterArea`. Afterwards the helper resets Pixi's cached GL state, so Pixi rebinds what it needs. Images Pixi has uploaded (`texture.source.resource`) draw from Pixi's own GPU textures, and stay marked as used, so Pixi's texture GC keeps them. Returns the container, with `spryte: { draw, dispose }`; `dispose` runs when the container is destroyed. The container's alpha, tint and blend mode don't apply: set them in `draw` calls. |

Needs Pixi's WebGL renderer, which runs on WebGL2 (`preference: "webgl"`; WebGPU isn't supported). Tested with PixiJS 8.22.0 (`npm run test:pixi` runs the example's real-GPU checks).

## Diagnostics and escape hatches

`kind` (`"webgl2"` or `"2d"`), `contextLost`, `quads` (submitted this frame), `drawCalls` (GPU draw calls this frame on WebGL2; one per quad on Canvas 2D), and `raw` (`{ kind: "webgl2", gl }` or `{ kind: "2d", ctx }`). If you mix raw calls with `draw` calls, restore the state you change.

## Resource ownership

- spryte never owns your images. Textures are cached per image object and dropped by `invalidate(image)` or `dispose()`.
- Text textures are owned by the text cache and evicted automatically.
- After a WebGL context loss, drawing is skipped. On restore, GPU objects are recreated and images re-upload on first use. You don't need to do anything.
