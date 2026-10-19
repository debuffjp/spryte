# spryte benchmarks

**Short version:** on the same machine, assets and simulation, spryte is **2.0–3.8× faster than PixiJS 8** on comparable APIs, and ships about **9× less JavaScript** at startup. A pixel-parity gate confirms both draw the same scene before anything is timed. These are one desktop machine's numbers; phones and other browsers aren't measured yet.

## Results, 2026-10-19

| | |
| --- | --- |
| GPU | NVIDIA RTX 5060 Laptop GPU (ANGLE, Direct3D 11) |
| CPU | AMD Ryzen 7 260 (15 GB RAM visible to the OS) |
| Browser | Chrome 155.0.8059.82, headless via Playwright |
| Power | AC power, power plan Turbo (detected by the runner) |
| Versions | spryte 0.1.0 plus the fixes released as 0.1.1 (debuff `3382872`), PixiJS 8.22.0 |
| Rounds | 3, interleaved; median frame, with min–max across rounds |

Raw data: `bench/renderer/results/2026-10-19-win32-{bunny,mixed,particles}.json` in the [debuff repo](https://github.com/debuffjp/debuff/tree/main/bench/renderer).

### Like for like

| Workload | spryte | PixiJS 8 | spryte is |
| --- | --- | --- | --- |
| **Dynamic particles**: position, scale, rotation, tint and alpha all change per particle, 200k | `draw.sprites` with `each`: **7.7 ms** (7.6–7.9) | `ParticleContainer`, those properties dynamic: 28.9 ms (28.4–29.7) | **3.8× faster** |
| **General sprites, mixed**: 4 textures, changing rotation, scale, tint and alpha, 50k | `draw.sprite`: **9.8 ms** (9.6–10.0) | `Sprite`: 32.3 ms (31.1–33.9) | **3.3× faster** |
| **General sprites, bunnymark**: one texture, position only, 50k | `draw.sprite`: **5.8 ms** (5.2–6.3) | `Sprite`: 16.4 ms (15.8–18.7) | **2.8× faster** |
| **Bulk, position only**, 200k | `draw.sprites`: **4.4 ms** (4.3–4.6) | `ParticleContainer`: 8.9 ms (8.9–9.1) | **2.0× faster** |

### Largest count at 60 fps

The largest ladder step measured in every round whose median frame is at most 16.7 ms. Steps are up to 2× apart, so these are lower bounds.

| Scene | spryte | PixiJS 8 |
| --- | --- | --- |
| bunny, bulk vs `ParticleContainer` | **800,000** | 200,000 |
| particles, all dynamic | **400,000** | 100,000 |
| bunny, `sprite()` vs `Sprite` | **100,000** | 50,000 |
| mixed, `sprite()` vs `Sprite` | **50,000** | 20,000 |

For reference, raw Canvas 2D `drawImage` holds 5,000 (28.7 ms at 10k), and so does spryte's Canvas 2D fallback (34.4 ms at 10k, about 20% slower than raw Canvas 2D because it supports tint and flash). debuff's `Game` on spryte matches plain spryte within noise (6.0 vs 5.8 ms at 50k).

### Pixel parity (a gate, not a footnote)

Before timing, each renderer draws the same seeded frame at 2,000 and at 50,000 sprites, which is compared with spryte's. The run **fails** if coverage (drawn area relative to the reference) leaves 99.5–100.5%, or if more than 0.5% of pixels differ **inside sprites**: where the 3×3 neighbourhood is one flat colour in both frames, so edges don't count.

| Scene | Coverage | Pixels differing overall | Inside sprites |
| --- | --- | --- | --- |
| bunny (PixiJS `Sprite`, `ParticleContainer`, Canvas 2D) | 100% | 0.04–0.08% | **0%** |
| mixed (PixiJS `Sprite`) | 99.8–100% | 8.8–12.7% | **0%** |
| particles (PixiJS `ParticleContainer`) | 99.8–100% | 8.6–11.4% | **0%** |

The overall differences in the rotated scenes are edges only. PixiJS's `roundPixels` snaps rotated corners, and spryte only snaps unrotated sprites. The interior metric is validated: giving PixiJS a deliberately wrong tint raised it from 0% to 22%. `PARITY_DUMP=1` writes the frames and diff images.

### Download size

From [`bench/size`](https://github.com/debuffjp/debuff/tree/main/bench/size) (committed apps, script and results): each app draws one rotated sprite, as a Vite 8 production build of the JS, brotli quality 11.

| | JS at startup | All JS, including lazy chunks |
| --- | --- | --- |
| **spryte** 0.1.1 | **10.1 kB** | 11.4 kB (the lazy part is the Canvas 2D fallback) |
| PixiJS 8.22 (`Application` + `Assets` + `Sprite`) | 87.8 kB | 152.0 kB |

The PixiJS "all JS" figure includes lazy chunks from `Application` and `Assets` that an app built without them avoids. A hand-minimised PixiJS app (a bare `WebGLRenderer`, no `Application` or `Assets`) measured about 90 kB in total, so the comparison that holds up is startup: **about 9×**.

## How a skeptic attacked this, and what changed

These results come after an adversarial review that tried to show the comparison favoured spryte. It found one real flaw: in the dynamic scenes, scale, tint and alpha never actually changed, which would let a PixiJS user mark them static. All of them now change over time, and PixiJS keeps them dynamic, as it should. That lowered the particles result from 4.2× to 3.8× and mixed from 3.8× to 3.3×. Things checked and found fair:

- PixiJS's WebGPU renderer is slower than its WebGL one on these scenes, so WebGL is used.
- `roundPixels` makes no speed difference.
- An atlas in the mixed scene helps PixiJS by about 11%, within noise. The scene deliberately measures multi-texture batching.
- The sync is the same for both renderers.
- Object creation happens only during warm-up.

## Method

The suite is in [`bench/renderer`](https://github.com/debuffjp/debuff/tree/main/bench/renderer), and its README has the full method. In brief:

- **Same work:** same seeded simulation and textures; 960×540, nearest filtering, no antialiasing, whole-pixel rounding (PixiJS `roundPixels: true`).
- **Parity gate first:** at 2k and 50k sprites, as above.
- **Honest timing:** each frame is timed from simulation to GPU completion (a 1-pixel readback), with 20 warm-up frames and 100 measured. The time includes the benchmark's own simulation, which every renderer pays.
- **Noise control:** rounds in rotated order. The published counts (10k, 50k, 200k) are measured for every renderer in every round, even past 60 fps.
- **Environment recorded automatically,** including power source and plan.

These rules are being generalised into **2dbench**, an open benchmark where any 2D web renderer can take part.

## Reading these honestly

- **One machine and one browser.** There are no phone, integrated-GPU, Safari or Firefox results yet. spryte's lead is mostly CPU and upload bandwidth, so fill-rate-bound devices may narrow it. Phones can run `bench/renderer/mobile.html`.
- **Specialised against specialised, general against general.** The bulk rows compare `draw.sprites` with `ParticleContainer`, and the general rows compare `draw.sprite` with `Sprite`.
- **Numbers from different days aren't comparable.** Only ratios within one run mean anything.
- **Not covered yet:** tilemaps, text-heavy UI, clipping-heavy scenes, render targets and shaders, object churn, memory growth, load time, time to first frame.
