# spryte benchmarks

**Short version:** on the same machine, assets and simulation, spryte 0.7.2 is **2.4-4.5x faster than PixiJS 8** on comparable APIs, and ships about **7x less JavaScript** at startup. A pixel-parity gate confirms both draw the same scene before anything is timed. These are one desktop machine's numbers. Across the other devices measured in [2dbench](https://github.com/debuffjp/2dbench#across-devices) (an RTX 4080 laptop on Linux, AMD integrated graphics, an Apple M5 Pro, iPhones in Safari and Chrome, an Android phone in Firefox), spryte's one-call-per-sprite path is ahead on every one.

## Results, 2026-10-28 (spryte 0.7.2)

Same machine, browser, power and method as the run below, with spryte 0.7.2 (PixiJS 8.22.0, Phaser 4.2.1) and 3-7 rounds per scene. spryte 0.7.2 does `draw.sprite`'s transform in the vertex shader, which is where the one-call-per-sprite rows moved. Raw data, all ten scenes: [`results/2026-10-28-win32-*.json`](https://github.com/debuffjp/2dbench/tree/main/results).

| Workload | spryte | PixiJS 8 | spryte is |
| --- | --- | --- | --- |
| **Dynamic particles**: position, scale, rotation, tint and alpha all change per particle, 200k | `draw.sprites` with per-copy arrays: **6.3 ms** (5.5-6.4) | `ParticleContainer`, those properties dynamic: 23.5 ms (23.0-24.0) | **3.7x faster** |
| **General sprites, mixed**: 4 textures, changing rotation, scale, tint and alpha, 50k | `draw.sprite`: **5.5 ms** (5.0-5.6) | `Sprite`: 20.2 ms (20.0-20.9) | **3.7x faster** |
| **General sprites, particles**: one call per sprite, everything changing, 50k | `draw.sprite`: **4.6 ms** (4.1-4.9) | `Sprite`: 20.5 ms (20.0-22.4) | **4.5x faster** |
| **General sprites, bunnymark**: one texture, position only, 50k | `draw.sprite`: **4.7 ms** (4.3-5.2) | `Sprite`: 11.3 ms (10.9-11.9) | **2.4x faster** |
| **Bulk, position only**, 200k | `draw.sprites`: **2.7 ms** (2.4-3.1) | `ParticleContainer`: 7.7 ms (6.2-9.9) | **2.9x faster** |

Largest count at 60 fps: bunny bulk **1,600,000** against `ParticleContainer`'s 400,000; particles bulk **400,000** against 100,000; `sprite()` against `Sprite` **100,000** against 20,000 (particles, mixed) and 50,000 (bunny); raycaster **10,000** enemies against 5,000. Parity passed in every scene with 0% of pixels differing inside sprites. Startup JS from [`bench/size`](https://github.com/debuffjp/debuff/tree/main/bench/size) (2026-10-28): spryte **12.7 kB**, PixiJS 87.8 kB, Phaser 276.6 kB.

## Results, 2026-10-20 (spryte 0.2.1)

| | |
| --- | --- |
| GPU | NVIDIA RTX 5060 Laptop GPU (ANGLE, Direct3D 11) |
| CPU | AMD Ryzen 7 260 (15 GB RAM visible to the OS) |
| Browser | Chrome 155.0.8059.85, headless via Playwright |
| Power | AC power, power plan Turbo (detected by the runner) |
| Versions | spryte 0.2.1, PixiJS 8.22.0 |
| Rounds | 3-7 per scene, interleaved; median frame, with min-max across rounds |

Measured with [2dbench](https://github.com/debuffjp/2dbench). Raw data: [`results/2026-10-20-win32-*.json`](https://github.com/debuffjp/2dbench/tree/main/results).

### Like for like

| Workload | spryte | PixiJS 8 | spryte is |
| --- | --- | --- | --- |
| **Dynamic particles**: position, scale, rotation, tint and alpha all change per particle, 200k | `draw.sprites` with per-copy arrays: **5.8 ms** (5.1-6.2) | `ParticleContainer`, those properties dynamic: 24.2 ms (23.5-29.0) | **4.2x faster** |
| **General sprites, mixed**: 4 textures, changing rotation, scale, tint and alpha, 50k | `draw.sprite`: **7.8 ms** (7.3-8.5) | `Sprite`: 27.1 ms (20.4-28.3) | **3.5x faster** |
| **General sprites, particles**: one call per sprite, everything changing, 50k | `draw.sprite`: **6.8 ms** (6.3-7.2) | `Sprite`: 22.4 ms (20.0-28.3) | **3.3x faster** |
| **General sprites, bunnymark**: one texture, position only, 50k | `draw.sprite`: **4.7 ms** (4.4-5.4) | `Sprite`: 12.2 ms (10.0-15.4) | **2.6x faster** |
| **Bulk, position only**, 200k | `draw.sprites`: **2.8 ms** (2.4-2.9) | `ParticleContainer`: 7.2 ms (6.6-7.6) | **2.6x faster** |

### Largest count at 60 fps

The largest ladder step measured in every round whose median frame is at most 16.7 ms. Steps are up to 2x apart, so these are lower bounds.

| Scene | spryte | PixiJS 8 |
| --- | --- | --- |
| bunny, bulk vs `ParticleContainer` | **800,000** | 400,000 |
| particles, bulk vs `ParticleContainer` | **400,000** | 100,000 |
| particles, `sprite()` vs `Sprite` | **100,000** | 20,000 |
| mixed, `sprite()` vs `Sprite` | **100,000** | 20,000 |
| bunny, `sprite()` vs `Sprite` | **100,000** | 50,000 |
| raycaster (enemies) | **20,000** | 5,000 |

For reference, raw Canvas 2D `drawImage` holds 5,000 (23.3 ms at 10k).

### Pixel parity (a gate, not a footnote)

Before timing, each renderer draws the same seeded frame at 2,000 and at 50,000 sprites, which is compared with PixiJS `Sprite`'s. The run **fails** if coverage (drawn area relative to the reference) leaves 99.5-100.5%, or if more than 0.5% of pixels differ **inside sprites**: where the 3x3 neighbourhood is one flat colour in both frames, so edges don't count.

| Scene | Coverage | Pixels differing overall | Inside sprites |
| --- | --- | --- | --- |
| bunny (spryte, Canvas 2D) | 100% | 0.04-0.08% | **0%** |
| mixed (spryte `draw.sprite`) | 99.9-100% | 8.8-12.7% | **0%** |
| particles (spryte `draw.sprite`, `draw.sprites`) | 99.9-100% | 8.6-11.4% | **0%** |

The overall differences in the rotated scenes are edges only. PixiJS's `roundPixels` snaps rotated corners, and spryte only snaps unrotated sprites. The interior metric is validated: giving PixiJS a deliberately wrong tint raised it from 0% to 22%. `PARITY_DUMP=1` writes the frames and diff images.

### Download size

From [`bench/size`](https://github.com/debuffjp/debuff/tree/main/bench/size) (committed apps, script and results): each app draws one rotated sprite, as a Vite 8 production build of the JS, brotli quality 11.

| | JS at startup | All JS, including lazy chunks |
| --- | --- | --- |
| **spryte** main (2026-10-21) | **11.3 kB** | 13.0 kB (the lazy part is the Canvas 2D fallback) |
| PixiJS 8.22 (`Application` + `Assets` + `Sprite`) | 87.8 kB | 152.0 kB |

The PixiJS "all JS" figure includes lazy chunks from `Application` and `Assets` that an app built without them avoids. A hand-minimised PixiJS app (a bare `WebGLRenderer`, no `Application` or `Assets`) measured about 90 kB in total, so the comparison that holds up is startup: **about 8x**. Shapes, masks, filters, `nineSlice` and `tiled` are imported functions, so they add nothing here unless an app uses them.

## Against Phaser 4

Same laptop and harness, 2026-10-21, 5 rounds, spryte 0.2.1, Phaser 4.2.1. Raw data: [`results/community/*-rtx-5060-laptop-phaser-*.json`](https://github.com/debuffjp/2dbench/tree/main/results/community).

| Workload, 50k sprites unless noted | spryte | Phaser 4 | spryte is |
| --- | --- | --- | --- |
| Bunnymark: `draw.sprite` against `Image` | **4.8 ms** | 15.0 ms | **3.1x faster** |
| Mixed, 4 textures, everything changing | **7.4 ms** | 20.0 ms | **2.7x faster** |
| Particles, one call per sprite | **6.9 ms** | 19.9 ms | **2.9x faster** |
| Particles, bulk: `draw.sprites` against `SpriteGPULayer` | **1.9 ms** | 9.5 ms | **5.0x faster** |
| Raycaster, 10k enemies (2026-10-22) | **10.1 ms** | 22.3 ms | **2.2x faster** |

Phaser 4 renders through WebGL1 and is driven with `game.step()`, as a game would be. `SpriteGPULayer` is built for members that rarely change; it's Phaser's only bulk path with per-sprite rotation, scale and tint, so moving particles use it against its design. Phaser's startup JS is 276.6 kB (one prebuilt bundle that can't be tree-shaken). Parity passed with 0% interior difference in every scene. Write-up: [spryte vs Phaser](https://debuff.jp/blog/spryte-vs-phaser).

## Checked for fairness

A review set out to show the comparison favoured spryte. In the dynamic scenes every property (scale, tint, alpha, rotation) changes over time, so no library can skip work by caching, and PixiJS keeps them dynamic, as it should. Also checked and found fair:

- PixiJS's WebGPU renderer is slower than its WebGL one on these scenes, so WebGL is used.
- `roundPixels` makes no speed difference.
- An atlas in the mixed scene helps PixiJS by about 11%, within noise. The scene deliberately measures multi-texture batching.
- The sync is the same for both renderers.
- Object creation happens only during warm-up.

## Method

[2dbench's METHOD](https://github.com/debuffjp/2dbench/blob/main/METHOD.md) has the full method. In brief:

- **Same work:** one shared, seeded simulation and the same textures; 960x540, nearest filtering, no antialiasing, whole-pixel rounding (PixiJS `roundPixels: true`).
- **Parity gate first:** at 2k and 50k sprites, as above.
- **Honest timing:** each frame is timed from simulation to GPU completion, after warm-up frames. The time includes the benchmark's own simulation, which every renderer pays.
- **Noise control:** rounds in rotated order. The published counts (10k, 50k, 200k) are measured for every renderer in every round, even past 60 fps.
- **Environment recorded automatically,** including power source and plan.

## How to read these

- **Devices differ, ratios hold.** The table above is one machine. In [2dbench](https://github.com/debuffjp/2dbench#across-devices), spryte's one-call-per-sprite path leads on every device so far (2.7-3.8x on desktops and iPhones, 1.6x on an Android phone). The bulk paths finish level on iPhones, where the GPU's fill rate is the limit. [Run it on your device](https://debuffjp.github.io/2dbench/mobile.html).
- **Specialised against specialised, general against general.** The bulk rows compare `draw.sprites` with `ParticleContainer`, and the general rows compare `draw.sprite` with `Sprite`.
- **Numbers from different days aren't comparable.** Only ratios within one run mean anything.
- **Not covered here:** memory growth, load time, time to first frame. 2dbench has further scenes (tilemaps, churn, clipping, render targets, uploads, text) in its [community results](https://debuffjp.github.io/2dbench/results.html).
