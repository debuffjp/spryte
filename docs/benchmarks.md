# spryte benchmarks

The suite lives in the debuff monorepo at `bench/renderer`. It runs in real Chrome through Playwright:

```bash
npm run build
npm run bench:renderer                          # bunnymark, all renderers
npm run bench:renderer -- mixed                 # mixed scene: spryte, debuff, PixiJS Sprite
npm run bench:renderer -- particles             # fully dynamic particles: spryte vs ParticleContainer
npm run bench:renderer -- spryte pixi-sprite    # a subset
```

## Method

- The same deterministic simulation and the same 16×16 canvas textures for every renderer, nearest filtering, no antialiasing, 960×540.
- Each frame is timed from simulation to GPU completion, forced by a 1-pixel `readPixels` (`createImageBitmap` for Canvas 2D). Vsync and rAF pacing can't hide cost. Each count gets 20 warm-up frames, then 100 measured; the median is reported.
- "Max at 60 fps" is the largest count on a ×2 ladder (1k, 2k, 5k, …) whose median frame fits 16.7 ms. It's a lower bound within 2×.
- **bunny:** one texture, position only. **mixed:** 4 separate textures (not an atlas), with per-sprite rotation, scale, tint and alpha.
- Results are saved to `bench/renderer/results/<date>-<platform>-<scene>.json`, with the GPU string and the browser version.

## Results, 2026-10-19

Windows 11, Chrome (Playwright), ANGLE D3D11, NVIDIA RTX 5060 Laptop GPU. All rows in a table come from one session.

**bunny** (frame = CPU + GPU, median)

| Renderer | Max @60fps | 10k | 50k | 200k |
| --- | --- | --- | --- | --- |
| **spryte `draw.sprites()`** (bulk, Float32Array) | **≥ 800,000** (top of the ladder) | 0.7 ms | 1.3 ms | **3.8 ms** |
| PixiJS 8 `ParticleContainer` | 200,000 | 1.4 ms | 4.1 ms | 11.3 ms |
| spryte `draw.sprite()` loop | 100,000 | 1.6 ms | 5.4 ms | 20.6 ms |
| debuff `Game` on spryte (`sprite()` loop) | 100,000 | 2.1 ms | 6.3 ms | 20.5 ms |
| PixiJS 8 `Sprite` | 20,000 | 5.3 ms | 21.2 ms | n/a |
| Canvas 2D `drawImage` | 5,000 | 29.9 ms | 148.0 ms | n/a |
| spryte Canvas 2D fallback (via debuff) | 5,000 | 29.7 ms | 224.6 ms | n/a |

**particles** (one texture; per-sprite position, scale, rotation, tint and alpha, all changing every frame: ParticleContainer with every dynamic property on)

| Renderer | Max @60fps | 10k | 50k | 200k |
| --- | --- | --- | --- | --- |
| **spryte `draw.sprites(…, each)`** | **400,000** | 0.8 ms | 2.9 ms | **6.6 ms** |
| PixiJS 8 `ParticleContainer` (all dynamic) | 100,000 | 2.3 ms | 7.4 ms | 26.8 ms |

**mixed**

| Renderer | Max @60fps | 10k | 50k |
| --- | --- | --- | --- |
| spryte | 50,000 | 2.3 ms | 7.2 ms |
| debuff `Game` on spryte | 50,000 | 2.4 ms | 9.5 ms |
| PixiJS 8 `Sprite` | 20,000 | 7.5 ms | 33.4 ms |

## Download size

Each app draws one rotated sprite: spryte with `createRenderer` + `draw.sprite`, and PixiJS 8.22 with `Application` + `Assets.load` + `Sprite`. Both are Vite 8 production builds, measured as brotli of the JS.

| | JS at startup | All JS (including lazy chunks) |
| --- | --- | --- |
| **spryte** (with bulk sprites, render targets and shaders) | **8.4 kB** | 9.7 kB (the Canvas 2D fallback is the lazy part) |
| PixiJS 8 | 87.8 kB | 151.9 kB |

That's about 10× less JS to download before the first frame, which matters most on phones and slow connections.

## Reading these honestly

- **Like for like on the bulk path:** `draw.sprites()` vs `ParticleContainer`, both moving one texture by position only, is about **3× faster at 200k** (3.8 vs 11.3 ms) and holds 60 fps at **4× the count** or more. The reason is bandwidth: spryte uploads 8 bytes per copy, straight from your `Float32Array`. It's checked pixel-identical to a `sprite()` loop on a real GPU.
- **Fully dynamic particles** (Pixi's best case): `sprites()` with per-copy arrays is about **4× faster** at 200k (6.6 vs 26.8 ms) and holds 60 fps at 4× the count.
- **Like for like on the general path:** a `draw.sprite()` loop vs PixiJS `Sprite` is about **4× faster** at 50k (5.4 vs 21.2 ms). On the mixed scene (rotation, scale, tint, alpha, 4 textures) it's about **4.6× faster**.
- The bulk path's 200k CPU time (2.3 ms) is mostly the benchmark's own simulation and copy loop, which every renderer pays.
- Run-to-run noise on this laptop is about ±15%, and absolute numbers vary between days: every renderer measured slower here than on 2026-10-16. Compare rows within a table, not across dates.
- The debuff rows include `Game`'s own requestAnimationFrame loop, which keeps running during measurement and can add frames. Treat them as an upper bound on the framework's overhead.
- This is one machine and one browser. There are **no mobile, integrated-GPU, Firefox or Safari results yet.**
- Not yet covered: tilemaps, text-heavy UI, clipping, render targets, object churn, memory growth, load time, time to first frame.
