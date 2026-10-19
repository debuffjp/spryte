import type { Frame } from "./draw.js";

export interface BitmapFontOptions {
  /** One frame per glyph, in the order of `chars`: usually `assets.frames("font")` from a `font@WxH.png` grid. */
  frames: readonly Frame[];
  /** The characters the frames hold, in order. */
  chars: string;
  /**
   * Advance per glyph in pixels. Default: measured from each glyph's rightmost opaque column, so a
   * grid drawn in Aseprite becomes a proportional font. Pass a number for a monospaced font.
   */
  widths?: readonly number[] | number;
  /** Pixels between glyphs. Default 1. */
  spacing?: number;
  /** Advance for a space (and any glyph that measures empty). Default a third of the cell height, rounded. */
  spaceWidth?: number;
  /** Pixels from one line's top to the next. Default the cell height + 1. */
  lineHeight?: number;
  /** Drawn for characters the font lacks. Default "?" if present, else nothing. */
  fallback?: string;
}

export interface Glyph {
  frame: Frame;
  /** Pixels to advance after drawing, before spacing. */
  advance: number;
}

/**
 * A pixel font from a sprite sheet. Pass it as `font` to `draw.text` and `draw.measure`: glyphs land
 * on whole pixels, so it stays crisp at any integer scale.
 *
 * ```ts
 * // assets/font@6x9.png: glyphs on a 6×9 grid, exported from Aseprite
 * const font = new BitmapFont({ frames: assets.frames("font"), chars: BitmapFont.ASCII });
 * draw.text("coins 3", 4, 4, { font, color: "#fbbf24" });
 * ```
 */
export class BitmapFont {
  /** Printable ASCII from space to "~", the order most font sheets use. */
  static readonly ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");

  /** Cell height in pixels. */
  readonly height: number;
  readonly lineHeight: number;
  readonly spacing: number;
  private readonly glyphs = new Map<string, Glyph>();
  private readonly fallback: Glyph | undefined;

  constructor(o: BitmapFontOptions) {
    const first = o.frames[0];
    if (!first) throw new Error("BitmapFont needs at least one frame");
    const chars = [...o.chars];
    if (chars.length > o.frames.length)
      throw new Error(`BitmapFont has ${chars.length} chars but only ${o.frames.length} frames; check the grid size in the file name`);
    this.height = first.h;
    this.lineHeight = o.lineHeight ?? first.h + 1;
    this.spacing = o.spacing ?? 1;
    const space = o.spaceWidth ?? Math.max(1, Math.round(first.h / 3));
    const measured = o.widths === undefined ? measureWidths(o.frames.slice(0, chars.length)) : undefined;
    chars.forEach((ch, i) => {
      const frame = o.frames[i] as Frame;
      const w = typeof o.widths === "number" ? o.widths : (o.widths?.[i] ?? measured?.[i] ?? frame.w);
      this.glyphs.set(ch, { frame, advance: w > 0 ? w : space });
    });
    this.fallback = this.glyphs.get(o.fallback ?? "?");
  }

  glyph(ch: string): Glyph | undefined {
    return this.glyphs.get(ch) ?? this.fallback;
  }

  /** Size of `text` in pixels. Lines split on "\n". */
  measure(text: string): { w: number; h: number } {
    if (!text) return { w: 0, h: 0 };
    const lines = text.split("\n");
    let w = 0;
    for (const line of lines) w = Math.max(w, this.lineWidth(line));
    return { w, h: (lines.length - 1) * this.lineHeight + this.height };
  }

  /** Width of one line, without trailing spacing. */
  lineWidth(line: string): number {
    let w = 0;
    let n = 0;
    for (const ch of line) {
      const g = this.glyph(ch);
      if (!g) continue;
      w += g.advance;
      n++;
    }
    return n ? w + (n - 1) * this.spacing : 0;
  }
}

/** Rightmost opaque column + 1 for each frame; 0 for empty ones. Falls back to the frame width without a 2D canvas. */
function measureWidths(frames: readonly Frame[]): number[] {
  const cache = new Map<unknown, { data: Uint8ClampedArray; width: number } | null>();
  return frames.map((f) => {
    let img = cache.get(f.image);
    if (img === undefined) {
      img = readPixels(f.image);
      cache.set(f.image, img);
    }
    if (!img) return f.w;
    for (let x = f.w - 1; x >= 0; x--)
      for (let y = 0; y < f.h; y++) if ((img.data[((f.y + y) * img.width + f.x + x) * 4 + 3] ?? 0) > 0) return x + 1;
    return 0;
  });
}

function readPixels(src: Frame["image"]): { data: Uint8ClampedArray; width: number } | null {
  const w = "naturalWidth" in src ? src.naturalWidth : (src as { width: number }).width;
  const h = "naturalHeight" in src ? src.naturalHeight : (src as { height: number }).height;
  if (!w || !h) return null;
  try {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(src as CanvasImageSource, 0, 0);
    return { data: ctx.getImageData(0, 0, w, h).data, width: w };
  } catch {
    return null;
  }
}
