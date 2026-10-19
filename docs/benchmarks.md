# spryte benchmarks

**Short version:** on the same machine, the same assets and the same simulation, spryte is **1.8–4.2× faster than PixiJS 8** on comparable APIs, and ships about **10× less JavaScript**. Both renderers are checked to draw the same pixels. These are one desktop machine's numbers; phones and other browsers aren't measured yet.

## Results, 2026-10-19

| | |
| --- | --- |
| GPU | NVIDIA RTX 5060 Laptop GPU (ANGLE, Direct3D 11) |
| CPU | AMD Ryzen 7 260 (15 GB RAM visible to the OS) |
| Browser | Chrome 155.0.8059.82, headless via Playwright |
| Power | AC power, power plan Turbo |
| Versions | spryte 0.1.0 (debuff `638bd23`), PixiJS 8.22.0 |
| Rounds | 3, interleaved; median frame, with min–max across rounds |

Raw data: `bench/renderer/results/2026-10-19-win32-{bunny,mixed,particles}.json` in the [debuff repo](https://github.com/debuffjp/debuff/tree/main/bench/renderer).

### Like for like

| Workload | spryte | PixiJS 8 | spryte is |
| --- | --- | --- | --- |
| **Dynamic particles**: per-particle position, scale, rotation, tint and alpha, 200k | `draw.sprites` with `each`: **7.3 ms** (6.4–7.8) | `ParticleContainer`, every dynamic property: 31.0 ms (26.1–31.8) | **4.2× faster** |
| **General sprites, mixed**: 4 textures, rotation, scale, tint and alpha, 50k | `draw.sprite`: **8.6 ms** (8.2–8.9) | `Sprite`: 33.1 ms (32.2–35.2) | **3.8× faster** |
| **General sprites, bunnymark**: one texture, position only, 50k | `draw.sprite`: **5.7 ms** (4.7–5.9) | `Sprite`: 16.0 ms (15.7–16.6) | **2.8× faster** |
| **Bulk, position only**, 200k | `draw.sprites`: **4.4 ms** (4.2–4.4) | `ParticleContainer`: 8.1 ms (7.8–8.9) | **1.8× faster**, and 60 fps at 800k vs 200k |

### Largest count at 60 fps (median frame ≤ 16.7 ms in every round)

| Scene | spryte | PixiJS 8 |
| --- | --- | --- |
| bunny, bulk vs `ParticleContainer` | **800,000** | 200,000 |
| bunny, `sprite()` vs `Sprite` | **100,000** | 50,000 |
| mixed, `sprite()` vs `Sprite` | **50,000** | 20,000 |
| particles, all dynamic | **400,000** | 100,000 |

For reference, on bunnymark raw Canvas 2D `drawImage` holds 5,000 sprites (26.5 ms at 10k), and spryte's own Canvas 2D fallback also holds 5,000. debuff `Game` on spryte matches plain spryte within noise (5.7 ms at 50k), so the framework adds nothing measurable.

### Pixel parity

Before timing, each renderer draws the same seeded frame (2,000 sprites), which is compared with spryte's:

| Scene | Coverage vs spryte | Pixels differing (edges) |
| --- | --- | --- |
| bunny: PixiJS `Sprite` and `ParticleContainer`, Canvas 2D | 100% | 0.04–0.06% |
| mixed: PixiJS `Sprite` | 99.9% | 8.8% |
| particles: PixiJS `ParticleContainer` | 99.9% | 8.6% |

Coverage is what would expose skipped or culled work, and every renderer draws the full scene. The differing pixels sit on the edges of rotated sprites: PixiJS's `roundPixels` snaps rotated corners, and spryte only snaps unrotated sprites. `PARITY_DUMP=1` writes the frames and a diff image so you can look for yourself.

### Download size

Each app draws one rotated sprite: spryte with `createRenderer` + `draw.sprite`, and PixiJS 8.22 with `Application` + `Assets.load` + `Sprite`. Both are Vite 8 production builds, measured as brotli of the JS.

| | JS at startup | All JS (including lazy chunks) |
| --- | --- | --- |
| **spryte** (with bulk sprites, render targets and shaders) | **8.4 kB** | 9.7 kB (the Canvas 2D fallback is the lazy part) |
| PixiJS 8 | 87.8 kB | 151.9 kB |

## Method

The suite lives in the debuff monorepo at [`bench/renderer`](https://github.com/debuffjp/debuff/tree/main/bench/renderer). Full details are in its README. In brief:

- **Same work.** Same deterministic simulation and the same 16×16 canvas textures. 960×540, nearest filtering, no antialiasing, whole-pixel rounding (PixiJS `roundPixels: true`). Pixel parity is checked first.
- **Honest timing.** Each frame is timed from simulation to GPU completion, forced by a 1-pixel readback, so vsync can't hide cost. 20 warm-up frames, then 100 measured frames per count. The time includes the benchmark's own simulation, which every renderer pays equally.
- **Noise control.** Several rounds, with renderer order rotated each round. Reported as the median with min–max.
- **Full environment recorded** with every result, including the power source and plan, since laptops throttle.

```bash
npm run build && npm run bench:renderer -- particles rounds=5
```

## Reading these honestly

- **One machine and one browser.** There are no phone, integrated-GPU, Safari or Firefox results yet, and ratios may differ there. Fill-rate-bound devices will narrow the gap, because spryte's advantage is mostly CPU and upload bandwidth.
- **The bulk comparisons pit specialised APIs against each other.** `draw.sprites` and `ParticleContainer` both trade flexibility for speed. The `sprite()` vs `Sprite` rows are the general-purpose comparison.
- **Numbers from different days aren't comparable.** On 2026-10-16 the same laptop measured every renderer faster (for example, PixiJS `Sprite` 50k at 12.5 ms, and the old debuff renderer 200k at 60 fps). Only ratios within one session mean anything.
- **Not covered yet:** tilemaps, text-heavy UI, clipping-heavy scenes, render-target and shader workloads, object churn, memory growth, load time and time to first frame.
