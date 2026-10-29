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

Every draw becomes `quad(matrix, source, srcRect, rgba, flash, smooth)`: a 2x3 affine matrix that maps the unit square into logical space. Rects use a 1x1 white texture, circles a cached 64 px disc, and text a cached raster or bitmap-font glyphs. Because there's only one primitive, any new feature that reduces to quads batches for free.

## WebGL2 backend

- **Instancing.** A static 4-vertex quad, plus one 56-byte instance per draw (13 floats and an RGBA8 colour). The buffer holds 16,384 instances and is flushed when full. An instance is one of two kinds, told apart by flags added to its texture unit, and both share a batch:
  - **Quad** (rects, text, shapes' sprites, panels): the finished matrix (6 floats), UV rect (4) and flash.
  - **Sprite** (`draw.sprite`): the call's own values, which are position, rotation, scale, origin, frame rect and flash. The vertex shader does `sprite()`'s transform algebra under the batch's transform (`u_linear`, `u_mt`) and works out UVs from each unit's texture size (`u_texinfo`), so the CPU skips a cos, a sin and a matrix product per sprite. Unrotated pixel art is rounded to whole pixels on the CPU in double precision, as before, and flagged so the shader uses that position as is. A sprite under a different transform than the batch's, or one that joins a pending shape batch, is sent as a quad instead, so neither breaks the batch. `Draw` bumps a version number whenever its transform changes; while a sprite batch is open under that version, with no shapes pending, the next sprite only needs its texture unit found (by image, over at most 8 units) before its instance is written. Anything else (a new transform, pending shapes, a full batch, context loss) takes the full path.

  Before 0.7.2, every draw was a 52-byte quad instance: matrix (6 floats), UV rect (4), flash and texture unit (2), RGBA8 colour, with `sprite()`'s algebra done on the CPU.
- **Multi-texture batches.** Up to 8 (texture, filter) pairs per draw call. Sampler objects carry the filtering, so one upload serves both smooth and pixelated draws.
- **What breaks a batch:** a 9th distinct texture/filter pair, a full buffer, a blend change, a clip change, `invalidate()`, and `end()`.
- **Per-copy pipeline** (`draw.sprites` with `each`): a third program that takes optional per-copy scale, rotation and packed RGBA8 colour as separate buffers. Absent ones read constant attribute defaults, so you only upload what you use. It runs `sprite()`'s transform algebra in the vertex shader, and snapping is decided per copy.
- **Copy pipeline** (`draw.sprites`): a second program in which each instance is just a `vec2` position (8 bytes, versus 52). The shared transform, UVs, tint and flash are uniforms, and pixel snapping happens in the vertex shader with the same rule as `sprite()`. A `Float32Array` is uploaded directly, so the CPU does no per-copy work. Other arrays go through a staging copy.
- **Custom shaders:** the user's `effect()` is spliced between spryte's fragment header (inputs, `source(uv)` over the 8 texture units) and its `main` (flash, output), behind a `#line 1`, so errors map to user lines. The instance format is unchanged, so custom-shader draws still batch. Each program uploads `u_view` only when the destination size changes. Uniforms upload at flush, and `set()` flushes first.
- **Render targets:** a framebuffer plus texture per target, created on first use. Sampling flips V, because GL stores the target bottom row first. Contents are already premultiplied, so they blend like uploaded images.
- **Premultiplied alpha** throughout: uploads premultiply, the blend is `ONE, ONE_MINUS_SRC_ALPHA` (`add`: `ONE, ONE`), and tint is premultiplied in the vertex shader.
- **Context loss:** `preventDefault` on loss, skip work while lost, and rebuild everything on restore.
- **Shared mode** (`createSharedRenderer`, a subclass in its own module so the canvas path doesn't carry it): the context belongs to another engine. Between frames nothing is assumed bound, so `begin()` binds the program, VAO, blend (`FUNC_ADD`, the mode's `blendFunc`), the host's framebuffer and viewport, and resets depth test, cull face, colour mask and `UNPACK_FLIP_Y`. The host's scissor and stencil are kept: clips intersect the host's scissor box and render targets draw unscissored, and `end()` gives the host's scissor back and unbinds samplers 0-7. What spryte leaves behind: its program, VAO, array buffer, active texture unit and the textures it bound. Context loss: the host owns the events (`preventDefault`, its own rebuild), so spryte's listeners only set flags, and the rebuild happens at the next `begin()` inside the host's slot, where state changes are expected. `begin()` also checks `isContextLost()`, but a flag is needed because a loss and restore can both fall between two frames.

## Canvas 2D backend

`setTransform` + `drawImage` per quad. Tint and flash composite through a scratch canvas, which is slow but only used when asked for. It's 20-40x slower than WebGL2 at sprite throughput, so it's a correctness fallback, not a performance path.

## Boundaries

spryte doesn't own the loop, input, audio, asset loading, cameras with game behaviour, scenes, or the canvas's CSS size and DPR policy. Those belong to the host (for example debuff's `Game`). spryte also doesn't allocate in the sprite hot path, and it has no runtime dependencies.

## Not yet

Masks beyond axis-aligned clips, more blend modes, meshes, mipmaps, GPU timers, and WebGPU. Each will be added when a real game needs it and a benchmark shows it doesn't cost the common path.
