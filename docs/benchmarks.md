# spryte benchmarks

The suite lives in the debuff monorepo at `bench/renderer`. It runs in real Chrome through Playwright:

```bash
npm run build
npm run bench:renderer                          # bunnymark, all renderers
npm run bench:renderer -- mixed                 # mixed scene: spryte, debuff, PixiJS Sprite
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

**bunny**

| Renderer | Max @60fps | 10k | 50k |
| --- | --- | --- | --- |
| spryte (`createRenderer`) | 100,000 | 1.8 ms | 5.5 ms |
| debuff `Game` on spryte | 100,000 | 1.8 ms | 5.7 ms |
| PixiJS 8 `Sprite` | 20,000 | 4.0 ms | 15.4 ms |
| PixiJS 8 `ParticleContainer` | 200,000 | 1.0 ms | 3.9 ms |
| Canvas 2D `drawImage` | 5,000 | 22.3 ms | 138.8 ms |
| spryte Canvas 2D fallback (via debuff) | 5,000 | 33.5 ms | 227.2 ms |

**mixed**

| Renderer | Max @60fps | 10k | 50k |
| --- | --- | --- | --- |
| spryte | 50,000 | 2.3 ms | 7.2 ms |
| debuff `Game` on spryte | 50,000 | 2.4 ms | 9.5 ms |
| PixiJS 8 `Sprite` | 20,000 | 7.5 ms | 33.4 ms |

## Reading these honestly

- In the same session, spryte is about **2.8× faster than PixiJS `Sprite`** on bunnymark at 50k, and about **4.6× faster** on the mixed scene.
- **PixiJS `ParticleContainer` beats spryte on bunnymark** (3.9 vs 5.5 ms at 50k). It's a specialised path (fixed texture, chosen dynamic properties), but it's the number to beat for particle-style workloads.
- Run-to-run noise on this laptop is about ±15%, and absolute numbers vary between days: every renderer measured slower here than on 2026-10-16. Compare rows within a table, not across dates.
- The debuff rows include `Game`'s own requestAnimationFrame loop, which keeps running during measurement and can add frames. Treat them as an upper bound on the framework's overhead.
- This is one machine and one browser. There are **no mobile, integrated-GPU, Firefox or Safari results yet.**
- Not yet covered: tilemaps, text-heavy UI, clipping, render targets, object churn, memory growth, load time, time to first frame.
