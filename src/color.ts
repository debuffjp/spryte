/** A colour: CSS hex string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or a number `0xRRGGBBAA`. */
export type Color = string | number;

const cache = new Map<string, number>();

/** Normalise a colour to `0xRRGGBBAA` (unsigned). Hex strings are cached; other CSS colours resolve through the browser. */
export function toRGBA(color: Color): number {
  if (typeof color === "number") return color >>> 0;
  const hit = cache.get(color);
  if (hit !== undefined) return hit;
  const value = parse(color);
  if (cache.size > 512) cache.clear();
  cache.set(color, value);
  return value;
}

function parse(input: string): number {
  let hex = input.trim();
  if (hex.startsWith("#")) {
    hex = hex.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length === 6) hex += "ff";
    if (hex.length === 8 && /^[0-9a-f]{8}$/i.test(hex)) return Number.parseInt(hex, 16) >>> 0;
  }
  return parseCss(input);
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let probe: Ctx2D | null | undefined;
/** Any other CSS colour (named, rgb(), hsl()…): let the browser resolve it once. */
function parseCss(input: string): number {
  if (probe === undefined) {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
    probe = canvas.getContext("2d", { willReadFrequently: true }) as Ctx2D | null;
  }
  if (!probe) throw new Error(`Cannot parse colour "${input}" without a 2D canvas; use hex`);
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = input;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** `0xRRGGBBAA` to a CSS colour string. */
export function rgbaToCss(rgba: number, alphaScale = 1): string {
  const a = ((rgba & 0xff) / 255) * alphaScale;
  return `rgba(${rgba >>> 24},${(rgba >>> 16) & 0xff},${(rgba >>> 8) & 0xff},${a})`;
}
