// Colour palettes for every mode, five stops each, low to high (elevation, speed or depth).

export interface Palette {
  name: string;
  stops: number[];
}

export const PALETTES: Palette[] = [
  { name: "spryte", stops: [0xa78bfa, 0x38bdf8, 0xcffb2d, 0xfbbf24, 0xf472b6] },
  { name: "ocean", stops: [0x2b2160, 0x2f7fd0, 0x38bdf8, 0xc8f1ff, 0xffffff] },
  { name: "ember", stops: [0x3b0a0a, 0x9a2a12, 0xf97316, 0xfbbf24, 0xfff1c1] },
  { name: "aurora", stops: [0x1b1446, 0x7c3aed, 0x22d3ee, 0x34d399, 0xecfccb] },
  { name: "moss", stops: [0x1f2a14, 0x4d7c0f, 0x87a31d, 0xcffb2d, 0xf7ffe0] },
  { name: "mono", stops: [0x2a2f24, 0x5a6150, 0x9aa38c, 0xd4dacb, 0xffffff] },
];

/** The stops blended into `size` evenly spaced 0xRRGGBB colours. */
export function ramp(stops: number[], size = 64): Uint32Array {
  const out = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    const f = (i / (size - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(f));
    const u = f - k;
    const a = stops[k];
    const b = stops[k + 1];
    let c = 0;
    for (const sh of [16, 8, 0]) c |= Math.round(((a >> sh) & 255) * (1 - u) + ((b >> sh) & 255) * u) << sh;
    out[i] = c;
  }
  return out;
}

/** A CSS gradient of the stops, for the swatch buttons. */
export function css(stops: number[]): string {
  return `linear-gradient(90deg, ${stops.map((c) => `#${c.toString(16).padStart(6, "0")}`).join(", ")})`;
}
