# spryte architecture

```
createRenderer(canvas) ──▶ Draw (public, immediate mode)
                             │  transforms, clips, text cache, colour parsing, pixel snapping
                             ▼
                          Backend (internal interface: everything is a quad)
                          ├─ WebGL2Backend   instanced, multi-texture batches
                          └─ Canvas2DBackend fallback, lazy-loaded chunk
```

## One primitive

Every draw becomes `quad(matrix, source, srcRect, rgba, flash, smooth)`: a 2×3 affine matrix that maps the unit square into logical space. Rects use a 1×1 white texture, circles a cached 64 px disc, and text a cached raster or bitmap-font glyphs. Because there's only one primitive, any new feature that reduces to quads batches for free.

## WebGL2 backend

- **Instancing.** A static 4-vertex quad, plus one 52-byte instance per sprite: matrix (6 floats), UV rect (4), flash and texture unit (2), RGBA8 colour. The buffer holds 16,384 instances and is flushed when full.
- **Multi-texture batches.** Up to 8 (texture, filter) pairs per draw call. Sampler objects carry the filtering, so one upload serves both smooth and pixelated draws.
- **What breaks a batch:** a 9th distinct texture/filter pair, a full buffer, a blend change, a clip change, `invalidate()`, and `end()`.
- **Premultiplied alpha** throughout: uploads premultiply, the blend is `ONE, ONE_MINUS_SRC_ALPHA` (`add`: `ONE, ONE`), and tint is premultiplied in the vertex shader.
- **Context loss:** `preventDefault` on loss, skip work while lost, and rebuild everything on restore.

## Canvas 2D backend

`setTransform` + `drawImage` per quad. Tint and flash composite through a scratch canvas, which is slow but only used when asked for. It's 20–40× slower than WebGL2 at sprite throughput, so it's a correctness fallback, not a performance path.

## Boundaries

spryte doesn't own the loop, input, audio, asset loading, cameras with game behaviour, scenes, or the canvas's CSS size and DPR policy. Those belong to the host (for example debuff's `Game`). spryte also doesn't allocate in the sprite hot path, and it has no runtime dependencies.

## Not yet

Render targets, custom shaders, masks beyond axis-aligned clips, more blend modes, meshes, mipmaps, GPU timers, and WebGPU. Each will be added when a real game needs it and a benchmark shows it doesn't cost the common path.
