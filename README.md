# spryte

A small, fast 2D renderer for the web. Immediate-mode drawing (sprites, bulk sprites, rects, circles, lines, text, clips, blend modes, render targets, custom shaders) batched onto WebGL2 with instancing, with an automatic Canvas 2D fallback. No dependencies, no scene graph, no game framework.

spryte is the renderer inside [debuff](https://debuff.jp), extracted so it can be used on its own. **Status: early.** The API is what debuff games already use, but it's pre-1.0 and may change.

```bash
npm install spryte
```

```ts
import { createRenderer } from "spryte";

const draw = createRenderer(canvas, { smooth: false }); // smooth: false for pixel art
canvas.width = 640;
canvas.height = 360;
draw.resize(canvas.width, canvas.height);

function frame() {
  draw.begin("#111", 320, 180, 2); // clear colour, logical size, backing pixels per logical unit
  draw.rect(10, 10, 40, 20, "#cffb2d");
  draw.sprite(image, 160, 90, { rotation: 0.3, tint: "#f0f" });
  draw.text("hello", 8, 8);
  draw.end();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

A runnable version is in [`examples/minimal`](examples/minimal) (`npm run example`; add `?backend=2d` to see the fallback). Full reference: [docs/api.md](docs/api.md). How it works: [docs/architecture.md](docs/architecture.md).

## Lifecycle

- `createRenderer(canvas, options)` makes a `Draw`. WebGL2 when available; otherwise Canvas 2D, loaded on demand (frames before it loads draw nothing).
- You own the canvas size. After changing `canvas.width`/`height`, call `draw.resize(w, h)`.
- Each frame: `draw.begin(...)`, draw calls in order, `draw.end()`. Call order is draw order.
- `draw.invalidate(source)` re-uploads an image whose pixels changed (e.g. a canvas you draw into).
- `draw.dispose()` releases GPU resources and listeners.
- WebGL context loss is handled: drawing pauses while lost, and textures re-upload after restore.

## Diagnostics

`draw.kind` (`"webgl2"` or `"2d"`), `draw.quads` and `draw.drawCalls` per frame. `draw.raw` gives the underlying `WebGL2RenderingContext` or `CanvasRenderingContext2D` for escape hatches.

## Licence

MIT
