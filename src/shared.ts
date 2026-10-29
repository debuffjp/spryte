import type { ClipRect } from "./backend.js";
import { Draw } from "./draw.js";
import type { RenderTarget } from "./target.js";
import { type BorrowedTexture, type ImageSource, WebGL2Backend } from "./webgl2.js";

export type { BorrowedTexture };

export interface SharedRendererOptions {
  /** Linear filtering for images by default. Pass false for pixel art. Default true. */
  smooth?: boolean;
  /**
   * The host's texture for an image, if it has one, so spryte draws it instead of uploading a second copy. Asked
   * once per image per frame, so a texture the host frees or replaces is never drawn stale; keep it cheap. It must
   * hold premultiplied alpha. (In spryte 0.6 it was asked once per image and the answer kept.)
   */
  borrow?: (src: ImageSource) => BorrowedTexture | null;
}

/** spryte drawing on a WebGL2 context another engine owns. See `createSharedRenderer`. */
export interface SharedRenderer {
  readonly draw: Draw;
  /**
   * Where the next `draw.begin()` draws: the host's framebuffer (null for the canvas) and its size in pixels. Call it
   * when the host's destination changes, such as a filter or post-processing pass that renders into its own
   * framebuffer. Until it's called, drawing goes to the canvas at its current size.
   */
  target(framebuffer: WebGLFramebuffer | null, width: number, height: number): void;
}

/**
 * A `Draw` for a WebGL2 context another engine owns (Phaser, PixiJS, your own code), to draw with spryte inside the
 * host's frame and in its draw order, on one GPU context with no overlay canvas. Create it inside the slot the host
 * gives you for foreign drawing, since creating it changes GL state. Each frame, in that slot:
 * `shared.target(...)` if the host's destination changed, `draw.begin(null, width, height, scale)` (null draws
 * over the host's frame), draw, `draw.end()`.
 *
 * What spryte sets at `begin()` and leaves to the host afterwards is listed in `docs/architecture.md`. The host's
 * scissor and stencil are respected: a camera viewport or mask applies to spryte's drawing too, and spryte's own
 * clips intersect the host's scissor. Context loss is the host's: it must `preventDefault` on `webglcontextlost`
 * for the browser to restore the context, and spryte rebuilds its GPU objects at the first `begin()` after.
 */
export function createSharedRenderer(gl: WebGL2RenderingContext, options: SharedRendererOptions = {}): SharedRenderer {
  const backend = new SharedBackend(gl, options.borrow);
  const draw = new Draw(backend, options.smooth ?? true);
  draw.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
  return {
    draw,
    target(framebuffer, width, height) {
      backend.fb = framebuffer;
      backend.fbW = width;
      backend.fbH = height;
      draw.resize(width, height);
    },
  };
}

/**
 * The WebGL2 backend on a host's context: draws into the host's framebuffer, assumes nothing about GL state between
 * frames, keeps the host's scissor and stencil, and leaves no sampler objects bound (a host written for WebGL1 never
 * binds samplers, so spryte's would override its texture filtering).
 */
class SharedBackend extends WebGL2Backend {
  fb: WebGLFramebuffer | null = null;
  fbW: number;
  fbH: number;
  /** The host's scissor box at `begin()`, or null when its scissor test was off. */
  private hostScissor: Int32Array | null = null;
  /** The context was restored since the last frame: rebuild at the next `begin()`, inside the host's slot. */
  private restored = false;
  // Passive listeners: the host owns the events (its preventDefault lets the browser restore) and its own
  // rebuild. spryte only notes them, since a loss and restore can both happen between two frames.
  private readonly noteLost = () => {
    this.lost = true;
  };
  private readonly noteRestored = () => {
    this.restored = true;
  };

  constructor(
    gl: WebGL2RenderingContext,
    private readonly host?: SharedRendererOptions["borrow"],
  ) {
    super(gl);
    this.fbW = gl.drawingBufferWidth;
    this.fbH = gl.drawingBufferHeight;
    gl.canvas.removeEventListener("webglcontextlost", this.onLost);
    gl.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    gl.canvas.addEventListener("webglcontextlost", this.noteLost);
    gl.canvas.addEventListener("webglcontextrestored", this.noteRestored);
  }

  protected override borrow(src: ImageSource): BorrowedTexture | null {
    return this.host?.(src) ?? null;
  }

  override dispose(): void {
    this.gl.canvas.removeEventListener("webglcontextlost", this.noteLost);
    this.gl.canvas.removeEventListener("webglcontextrestored", this.noteRestored);
    super.dispose();
  }

  override begin(clear: number | null, width: number, height: number): void {
    const gl = this.gl;
    if (gl.isContextLost()) {
      this.lost = true;
      return;
    }
    if (this.lost || this.restored) {
      // Every GPU object died with the old context; the host has rebuilt its own by now.
      this.restored = false;
      this.onRestored();
    }
    // The host may have freed or re-created its textures since (Pixi's texture GC does), so ask again this frame.
    this.forgetBorrowed();
    // The host drew since last frame: rebind everything spryte otherwise assumes stays bound.
    gl.useProgram(this.active.program);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    this.applyBlend();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.colorMask(true, true, true, true);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Scissor and stencil stay as the host set them: its camera viewport or mask applies to spryte too.
    this.hostScissor = gl.isEnabled(gl.SCISSOR_TEST) ? gl.getParameter(gl.SCISSOR_BOX) : null;
    super.begin(clear, width, height);
  }

  protected override outputFramebuffer(): WebGLFramebuffer | null {
    return this.fb;
  }

  protected override bindOutput(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.fbW, this.fbH);
    this.outH = this.fbH;
    // Back on the host's framebuffer, where its scissor applies again (a render target had it off).
    this.scissor(null);
  }

  override setClip(rect: ClipRect | null): void {
    // Inside a render target the host's scissor doesn't apply: it's in the host framebuffer's pixels.
    if (this.target || this.lost) {
      super.setClip(rect);
      return;
    }
    this.flush();
    this.scissor(rect);
  }

  override setTarget(target: RenderTarget | null, clear: number | null, width: number, height: number): void {
    if (target && !this.lost && this.hostScissor) {
      // Submit what's queued for the host's framebuffer under its scissor, then draw the target unscissored.
      this.flush();
      this.gl.disable(this.gl.SCISSOR_TEST);
    }
    super.setTarget(target, clear, width, height);
  }

  override end(): void {
    this.flush();
    if (this.lost) return;
    const gl = this.gl;
    this.scissor(null);
    for (let i = 0; i < 8; i++) gl.bindSampler(i, null);
  }

  /** Set the scissor to spryte's clip (in the host framebuffer's top-left pixels) intersected with the host's. */
  private scissor(rect: ClipRect | null): void {
    const gl = this.gl;
    const host = this.hostScissor;
    if (!rect) {
      if (host) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(host[0] as number, host[1] as number, host[2] as number, host[3] as number);
      } else gl.disable(gl.SCISSOR_TEST);
      return;
    }
    // WebGL's scissor origin is bottom-left.
    let x = rect.x;
    let y = this.fbH - rect.y - rect.h;
    let w = rect.w;
    let h = rect.h;
    if (host) {
      const x1 = Math.min(x + w, (host[0] as number) + (host[2] as number));
      const y1 = Math.min(y + h, (host[1] as number) + (host[3] as number));
      x = Math.max(x, host[0] as number);
      y = Math.max(y, host[1] as number);
      w = Math.max(0, x1 - x);
      h = Math.max(0, y1 - y);
    }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, w, h);
  }
}
