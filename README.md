# spryte

A small, fast 2D renderer for the web. You draw in immediate mode (sprites, bulk sprites, rects, circles, lines, text, clips, blend modes, render targets and custom shaders), and spryte batches it onto WebGL2 with instancing, falling back to Canvas 2D automatically. No dependencies, no scene graph, no game framework.

> **Alpha.** spryte is the renderer inside [debuff](https://debuff.jp), where games already run on it. The API may still change before 1.0. So far it has been measured on desktop Chrome only; mobile and other browsers aren't verified yet.

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

## Why spryte

Measured against PixiJS 8 in the same session, with the same assets and the same simulation (desktop Chrome, RTX 5060 laptop). Full numbers and caveats are in [benchmarks](https://github.com/debuffjp/spryte/blob/main/docs/benchmarks.md).

| | spryte | PixiJS 8 |
| --- | --- | --- |
| JS at startup (brotli) | **8.4 kB** | 87.8 kB |
| 200k particles, position only | **3.8 ms** (`draw.sprites`) | 11.3 ms (`ParticleContainer`) |
| 200k particles, scale + rotation + tint + alpha per particle | **6.6 ms** | 26.8 ms |
| 50k sprites, one call each | **5.4 ms** (`draw.sprite`) | 21.2 ms (`Sprite`) |

- **Bulk sprites with no per-sprite JavaScript.** Pass a `Float32Array` of positions (plus optional per-copy scale, rotation and colour arrays) and spryte uploads it as is.
- **Immediate mode.** There are no display objects to create, pool or destroy. Draw what you want this frame.
- **Verified output.** Real-GPU pixel checks prove that the bulk paths, render targets and shaders draw exactly what the simple path draws.

```ts
// Particles: one call, no objects.
draw.sprites(spark, positions, count, { tint: "#ffd36b" }, { scale, rotation, color });

// Post-processing: draw into a target, then draw the target through a shader.
draw.into(scene, () => drawWorld(draw));
draw.withShader(crt, () => draw.sprite(scene, 0, 0, { origin: [0, 0] }));
```

## Docs

- [API reference](https://github.com/debuffjp/spryte/blob/main/docs/api.md)
- [Architecture](https://github.com/debuffjp/spryte/blob/main/docs/architecture.md)
- [Benchmarks and method](https://github.com/debuffjp/spryte/blob/main/docs/benchmarks.md)
- [Minimal example](https://github.com/debuffjp/spryte/tree/main/examples/minimal): run `npm run example`, and add `?backend=2d` to the URL to see the fallback

## Lifecycle

- `createRenderer(canvas, options)` makes a `Draw`. It uses WebGL2 when available, and otherwise Canvas 2D, loaded on demand. `await draw.ready` waits until the fallback can draw.
- You own the canvas size. After changing `canvas.width` or `canvas.height`, call `draw.resize(w, h)`.
- Each frame: `draw.begin(...)`, then your draw calls in order, then `draw.end()`. Call order is draw order.
- `draw.invalidate(source)` re-uploads an image whose pixels changed. `draw.disposeTarget(t)` frees a render target.
- `draw.dispose()` releases every GPU resource and listener.
- WebGL context loss is handled: drawing pauses while the context is lost (`draw.contextLost`), and textures re-upload after it's restored.

## Licence

MIT
