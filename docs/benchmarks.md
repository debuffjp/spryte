# spryte benchmarks

**Short version:** on the same machine, assets and simulation, spryte is **2.6–4.2× faster than PixiJS 8** on comparable APIs, and ships about **9× less JavaScript** at startup. A pixel-parity gate confirms both draw the same scene before anything is timed. These are one desktop machine's numbers. Across the other devices measured in [2dbench](https://github.com/debuffjp/2dbench#across-devices) (an RTX 4080 laptop on Linux, AMD integrated graphics, an Apple M5 Pro, iPhones in Safari and Chrome, an Android phone in Firefox), spryte's one-call-per-sprite path is ahead on every one.

## Results, 2026-10-20

| | |
| --- | --- |
| GPU | NVIDIA RTX 5060 Laptop GPU (ANGLE, Direct3D 11) |
| CPU | AMD Ryzen 7 260 (15 GB RAM visible to the OS) |
| Browser | Chrome 155.0.8059.85, headless via Playwright |
| Power | AC power, power plan Turbo (detected by the runner) |
| Versions | spryte 0.2.1, PixiJS 8.22.0 |
| Rounds | 3–7 per scene, interleaved; median frame, with min–max across rounds |

Measured with [2dbench](https://github.com/debuffjp/2dbench). Raw data: [`results/2026-10-20-win32-*.json`](https://github.com/debuffjp/2dbench/tree/main/results).

### Like for like

| Workload | spryte | PixiJS 8 | spryte is |
| --- | --- | --- | --- |
| **Dynamic particles**: position, scale, rotation, tint and alpha all change per particle, 200k | `draw.sprites` with per-copy arrays: **5.8 ms** (5.1–6.2) | `ParticleContainer`, those properties dynamic: 24.2 ms (23.5–29.0) | **4.2× faster** |
| **General sprites, mixed**: 4 textures, changing rotation, scale, tint and alpha, 50k | `draw.sprite`: **7.8 ms** (7.3–8.5) | `Sprite`: 27.1 ms (20.4–28.3) | **3.5× faster** |
| **General sprites, particles**: one call per sprite, everything changing, 50k | `draw.sprite`: **6.8 ms** (6.3–7.2) | `Sprite`: 22.4 ms (20.0–28.3) | **3.3× faster** |
| **General sprites, bunnymark**: one texture, position only, 50k | `draw.sprite`: **4.7 ms** (4.4–5.4) | `Sprite`: 12.2 ms (10.0–15.4) | **2.6× faster** |
| **Bulk, position only**, 200k | `draw.sprites`: **2.8 ms** (2.4–2.9) | `ParticleContainer`: 7.2 ms (6.6–7.6) | **2.6× faster** |

### Largest count at 60 fps

The largest ladder step measured in every round whose median frame is at most 16.7 ms. Steps are up to 2× apart, so these are lower bounds.

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

Before timing, each renderer draws the same seeded frame at 2,000 and at 50,000 sprites, which is compared with PixiJS `Sprite`'s. The run **fails** if coverage (drawn area relative to the reference) leaves 99.5–100.5%, or if more than 0.5% of pixels differ **inside sprites**: where the 3×3 neighbourhood is one flat colour in both frames, so edges don't count.

| Scene | Coverage | Pixels differing overall | Inside sprites |
| --- | --- | --- | --- |
| bunny (spryte, Canvas 2D) | 100% | 0.04–0.08% | **0%** |
| mixed (spryte `draw.sprite`) | 99.9–100% | 8.8–12.7% | **0%** |
| particles (spryte `draw.sprite`, `draw.sprites`) | 99.9–100% | 8.6–11.4% | **0%** |

The overall differences in the rotated scenes are edges only. PixiJS's `roundPixels` snaps rotated corners, and spryte only snaps unrotated sprites. The interior metric is validated: giving PixiJS a deliberately wrong tint raised it from 0% to 22%. `PARITY_DUMP=1` writes the frames and diff images.

### Download size

From [`bench/size`](https://github.com/debuffjp/debuff/tree/main/bench/size) (committed apps, script and results): each app draws one rotated sprite, as a Vite 8 production build of the JS, brotli quality 11.

| | JS at startup | All JS, including lazy chunks |
| --- | --- | --- |
| **spryte** 0.1.1 | **10.1 kB** | 11.4 kB (the lazy part is the Canvas 2D fallback) |
| PixiJS 8.22 (`Application` + `Assets` + `Sprite`) | 87.8 kB | 152.0 kB |

The PixiJS "all JS" figure includes lazy chunks from `Application` and `Assets` that an app built without them avoids. A hand-minimised PixiJS app (a bare `WebGLRenderer`, no `Application` or `Assets`) measured about 90 kB in total, so the comparison that holds up is startup: **about 9×**.

## Checked for fairness

A review set out to show the comparison favoured spryte. In the dynamic scenes every property (scale, tint, alpha, rotation) changes over time, so no library can skip work by caching, and PixiJS keeps them dynamic, as it should. Also checked and found fair:

- PixiJS's WebGPU renderer is slower than its WebGL one on these scenes, so WebGL is used.
- `roundPixels` makes no speed difference.
- An atlas in the mixed scene helps PixiJS by about 11%, within noise. The scene deliberately measures multi-texture batching.
- The sync is the same for both renderers.
- Object creation happens only during warm-up.

## Method

[2dbench's METHOD](https://github.com/debuffjp/2dbench/blob/main/METHOD.md) has the full method. In brief:

- **Same work:** one shared, seeded simulation and the same textures; 960×540, nearest filtering, no antialiasing, whole-pixel rounding (PixiJS `roundPixels: true`).
- **Parity gate first:** at 2k and 50k sprites, as above.
- **Honest timing:** each frame is timed from simulation to GPU completion, after warm-up frames. The time includes the benchmark's own simulation, which every renderer pays.
- **Noise control:** rounds in rotated order. The published counts (10k, 50k, 200k) are measured for every renderer in every round, even past 60 fps.
- **Environment recorded automatically,** including power source and plan.

## Reading these honestly

- **Devices differ, ratios hold.** The table above is one machine. In [2dbench](https://github.com/debuffjp/2dbench#across-devices), spryte's one-call-per-sprite path leads on every device so far (2.7–3.8× on desktops and iPhones, 1.6× on an Android phone). The bulk paths finish level on iPhones, where the GPU's fill rate is the limit. [Run it on your device](https://debuffjp.github.io/2dbench/mobile.html).
- **Specialised against specialised, general against general.** The bulk rows compare `draw.sprites` with `ParticleContainer`, and the general rows compare `draw.sprite` with `Sprite`.
- **Numbers from different days aren't comparable.** Only ratios within one run mean anything.
- **Not covered here:** memory growth, load time, time to first frame. 2dbench has further scenes (tilemaps, churn, clipping, render targets, uploads, text) in its [community results](https://debuffjp.github.io/2dbench/results.html).
