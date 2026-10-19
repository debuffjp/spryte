# spryte API

Everything is exported from `spryte`. Units are **logical**: you choose them in `begin()`, and spryte maps them onto the canvas's backing pixels.

## createRenderer(canvas, options?) → Draw

| Option | Default | |
| --- | --- | --- |
| `backend` | `"auto"` | `"auto"`: WebGL2, falling back to Canvas 2D. `"webgl2"`: throws if WebGL2 is unavailable. `"2d"`: always Canvas 2D. |
| `smooth` | `true` | Default image filtering. Use `false` for pixel art. Can be overridden per sprite. |

The Canvas 2D backend is a separate chunk, loaded only on fallback. Until it arrives (a few milliseconds), frames draw nothing.

## Frame lifecycle

```ts
draw.resize(canvas.width, canvas.height); // after you change the canvas's backing size
draw.begin(clear, width, height, scale);  // clear colour, logical size, backing pixels per logical unit
// ...draw calls, in paint order...
draw.end();                               // submits the frame
draw.dispose();                           // frees GPU objects and listeners; the Draw is unusable after
```

`scale` is usually `canvas.width / width` (CSS scale × `devicePixelRatio`). It also sets the resolution that text is rasterised at.

## Drawing

| Method | |
| --- | --- |
| `rect(x, y, w, h, color)` | Filled rectangle. |
| `circle(x, y, r, color)` | Filled, antialiased circle. |
| `line(x1, y1, x2, y2, width, color)` | Drawn as a rotated rectangle. |
| `sprite(frameOrImage, x, y, options?)` | Image or `Frame` (`{ image, x, y, w, h }`), anchored at `origin` (default centre). Options: `origin`, `scaleX`, `scaleY`, `rotation` (radians), `flipX`, `flipY`, `alpha`, `tint`, `flash` (0–1 toward white), `smooth`. **Doesn't allocate:** reuse one options object in hot loops. |
| `sprites(frame, positions, count?, options?, each?)` | One frame at many positions: particles, bullets, swarms. `positions` is x, y pairs. Pass a reused `Float32Array` and it's uploaded to the GPU as is, with **no JavaScript work per copy**. `options` apply to every copy. `each` adds per-copy values: `scale` (Float32Array), `rotation` (Float32Array, radians) and `color` (Uint32Array of `0xRRGGBBAA`, multiplied with the tint). These are also uploaded as is. The output is pixel-identical to a `sprite()` loop with the same values, including pixel snapping (checked on a real GPU by `npm run test:browser`). It's one draw call on WebGL2 and breaks the current batch. |
| `text(text, x, y, options?)` | `font` (CSS string or `BitmapFont`), `color`, `align`, `baseline`, `alpha`. CSS text is rasterised once and cached (LRU, 256 entries). |
| `measure(text, font?)` | Logical `{ w, h }` that `text()` fills. |

**Colours** are CSS hex strings (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), numbers `0xRRGGBBAA`, or any CSS colour (resolved once through a canvas, then cached).

## State

| | |
| --- | --- |
| `push()`, `pop()`, `translate(x, y)`, `scale(x, y?)`, `rotate(rad)` | Transform stack. `begin()` resets it. |
| `clip(x, y, w, h, fn)` | Draws inside `fn` are clipped to the rectangle's screen bounds. Nested clips intersect. |
| `withCamera(camera, fn)` | Applies `camera.view()` (any `{ view(): Matrix }`) for the draws inside `fn`. |
| `blend(mode)` | `"normal"` or `"add"`. |
| `alpha` | Global alpha multiplier. |
| `smooth` | Default filtering. |
| `font` | Default font: a CSS string, a `BitmapFont`, or a function returning one (evaluated lazily). |
| `invalidate(image)` | Re-upload an image whose pixels changed. |

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

- `into()` nests, and restores the outer transform, clips, alpha and destination afterwards, even if `fn` throws.
- Drawing a target into itself, or disposing it while you're drawing into it, throws.
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

- `color` is the draw's tint × alpha, premultiplied. Flash is applied after your effect.
- Shaders compile on first use. Errors throw with the driver's message, and line numbers refer to your source.
- `set()` affects only draws made after it, even inside the same scope.
- Shaders compose with render targets: draw into a target, then draw the target through a shader for full-screen post-processing.
- `sprites()` inside `withShader` falls back to one quad per copy, which is correct but without the bulk speed-up.

## Diagnostics and escape hatches

`kind` (`"webgl2"` or `"2d"`), `contextLost`, `quads` (submitted this frame), `drawCalls` (GPU draw calls this frame on WebGL2; one per quad on Canvas 2D), and `raw` (`{ kind: "webgl2", gl }` or `{ kind: "2d", ctx }`). If you mix raw calls with `draw` calls, restore the state you change.

## Resource ownership

- spryte never owns your images. Textures are cached per image object and dropped by `invalidate(image)` or `dispose()`.
- Text textures are owned by the text cache and evicted automatically.
- After a WebGL context loss, drawing is skipped. On restore, GPU objects are recreated and images re-upload on first use. You don't need to do anything.
