import type { TextureSource } from "./backend.js";
import type { Draw } from "./draw.js";

export interface ElementDrawOptions {
  /** Logical size to draw at. Default: the element's CSS border box, one CSS pixel per logical unit. */
  w?: number;
  h?: number;
  /** Multiplied with the global alpha. */
  alpha?: number;
}

/** The parts of the HTML-in-Canvas API that spryte calls, while lib.dom lacks them. */
type DrawableCanvas = HTMLCanvasElement & {
  updateElementGeometry(el: Element, options: { canvasTransform: DOMMatrix }): void;
};
type Context2D = CanvasRenderingContext2D & {
  drawElementImage(el: Element, dx: number, dy: number, dw: number, dh: number): void;
};
type GL = WebGL2RenderingContext & {
  texElementSubImage2D(target: number, level: number, x: number, y: number, el: Element, size: { width: number; height: number }): void;
};
type PaintEvent = Event & { changedElements: readonly Element[] };

interface Upload {
  gl: WebGL2RenderingContext;
  tex: WebGLTexture;
  pw: number;
  ph: number;
}

const uploads = new WeakMap<Element, Upload>();
/** Per canvas, the drawn elements whose snapshot changed since their last upload. */
const changed = new WeakMap<HTMLCanvasElement, Set<Element>>();

/** True when this browser can draw DOM elements into a canvas (Chromium's HTML-in-Canvas API). */
export function canDrawElements(): boolean {
  return typeof HTMLCanvasElement !== "undefined" && "updateElementGeometry" in HTMLCanvasElement.prototype;
}

/**
 * Draw a DOM element (a menu, a text field, wrapped or rich text) with its top-left at `x, y`, through the
 * browser's HTML-in-Canvas API. The element stays live DOM: it takes clicks, focus and typing where it is
 * drawn, and screen readers read it. The first call moves it into the canvas and draws nothing; later calls
 * show its layout from the previous frame. Returns false, drawing nothing, where the API is missing (Chrome and
 * Edge 157 and later have it; Firefox and Safari don't), inside `into()` or a mask, and until the browser has
 * painted the element once.
 *
 * Inside the canvas, the element's CSS margins and position don't place it on screen: `x, y` do. Keep the CSS for
 * browsers without the API, where the element stays in the page.
 *
 * ```ts
 * if (!drawElement(draw, menu, 40, 30)) drawCanvasMenu(); // your fallback
 * ```
 */
export function drawElement(draw: Draw, el: HTMLElement, x: number, y: number, o: ElementDrawOptions = {}): boolean {
  if (!canDrawElements() || draw.target || draw.maskDepth > 0) return false;
  const raw = draw.raw;
  const canvas = (raw.kind === "webgl2" ? raw.gl.canvas : raw.ctx.canvas) as DrawableCanvas;
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  if (el.parentElement !== canvas) {
    canvas.setAttribute("content", "drawable");
    el.setAttribute("drawable", "");
    canvas.append(el);
    return false;
  }
  const cw = el.offsetWidth;
  const ch = el.offsetHeight;
  if (!cw || !ch) return false;
  const w = o.w ?? cw;
  const h = o.h ?? ch;
  draw.local(x, y, w, h);
  const t = draw.tmp;
  const s = draw.renderScale;
  const alpha = (o.alpha ?? 1) * draw.alpha;
  if (raw.kind === "2d") {
    // Canvas 2D draws straight away, and places the element for hit testing as it draws.
    const ctx = raw.ctx as Context2D;
    ctx.setTransform(t[0] * s, t[1] * s, t[2] * s, t[3] * s, t[4] * s, t[5] * s);
    ctx.globalAlpha = alpha;
    try {
      ctx.drawElementImage(el, 0, 0, 1, 1);
    } catch {
      return false;
    }
    draw.quads++;
    return true;
  }
  // WebGL2: rasterise into a texture at the drawn size, only when the element changed.
  const gl = raw.gl as GL;
  const pw = Math.max(1, Math.round(Math.hypot(t[0], t[1]) * s));
  const ph = Math.max(1, Math.round(Math.hypot(t[2], t[3]) * s));
  let dirty = changed.get(canvas);
  if (!dirty) {
    const set = new Set<Element>();
    dirty = set;
    changed.set(canvas, set);
    canvas.addEventListener("paint", (e) => {
      for (const c of (e as PaintEvent).changedElements) set.add(c);
    });
  }
  let up = uploads.get(el);
  // A lost context deletes every texture, so a restored one starts again.
  if (up && (up.gl !== gl || up.pw !== pw || up.ph !== ph || !gl.isTexture(up.tex))) {
    if (up.gl === gl) gl.deleteTexture(up.tex);
    up = undefined;
  }
  const fresh = !up;
  if (!up) {
    const tex = gl.createTexture();
    if (!tex) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    up = { gl, tex, pw, ph };
    uploads.set(el, up);
  }
  if (fresh || dirty.has(el)) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, up.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, el, { width: pw, height: ph });
    } catch {
      // Not laid out inside the canvas yet.
      return false;
    }
    dirty.delete(el);
    // Unit 0 is now bound to this texture; spryte's next flush rebinds whatever its batch needs.
  }
  const key = el as unknown as TextureSource;
  draw.backend.lend?.(key, up.tex, pw, ph);
  draw.sprite({ image: key, x: 0, y: 0, w: pw, h: ph }, x, y, {
    origin: [0, 0],
    scaleX: w / pw,
    scaleY: h / ph,
    alpha: o.alpha ?? 1,
    smooth: true,
  });
  // Hit testing follows canvasTransform, in the canvas's CSS pixels.
  const k = (s * canvas.clientWidth) / canvas.width;
  draw.local(x, y, w, h);
  canvas.updateElementGeometry(el, {
    canvasTransform: new DOMMatrix([(t[0] * k) / cw, (t[1] * k) / cw, (t[2] * k) / ch, (t[3] * k) / ch, t[4] * k, t[5] * k]),
  });
  return true;
}
