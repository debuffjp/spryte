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

## Diagnostics and escape hatches

`kind` (`"webgl2"` or `"2d"`), `quads` (submitted this frame), `drawCalls` (GPU draw calls this frame on WebGL2; one per quad on Canvas 2D), and `raw` (`{ kind: "webgl2", gl }` or `{ kind: "2d", ctx }`). If you mix raw calls with `draw` calls, restore the state you change.

## Resource ownership

- spryte never owns your images. Textures are cached per image object and dropped by `invalidate(image)` or `dispose()`.
- Text textures are owned by the text cache and evicted automatically.
- After a WebGL context loss, drawing is skipped. On restore, GPU objects are recreated and images re-upload on first use. You don't need to do anything.
