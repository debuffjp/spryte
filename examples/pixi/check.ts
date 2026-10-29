// Scenes for check.mjs: each URL draws one situation with PixiJS v8 and spryte. The page renders frames on request
// (`__check.render(n)`) and reads the canvas right after, so no frame is missed.
//   scene = state | match | mask | filter | target | borrow | gc
//   spryte = 0 (the RenderContainer draws nothing, or Pixi draws the reference) | 1
//   share = 0 (borrow: spryte draws its own copies of Pixi's images) | 1
import {
  Application,
  ColorMatrixFilter,
  Container,
  Graphics,
  Rectangle,
  RenderContainer,
  RenderTexture,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import type { Draw } from "spryte";
import { spryteContainer } from "spryte/pixi";

const q = new URLSearchParams(location.search);
const sceneName = q.get("scene") ?? "state";
const spryteOn = q.get("spryte") !== "0";
const share = q.get("share") !== "0";
const W = 640;
const H = 360;

const out = {
  ready: false,
  errors: [] as string[],
  created: 0,
  render: (_n: number): number[] => [],
  /** Run Pixi's texture GC now, as if every texture not used in the last 50 ms were idle. */
  gc: () => {},
};
(window as unknown as { __check: typeof out }).__check = out;
window.addEventListener("error", (e) => out.errors.push(String(e.message)));

function canvas(w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d") as CanvasRenderingContext2D);
  return c;
}
const solid = (color: string, w = 16, h = 16) =>
  canvas(w, h, (c) => {
    c.fillStyle = color;
    c.fillRect(0, 0, w, h);
  });
const checker = canvas(4, 4, (c) => {
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      c.fillStyle = (x + y) % 2 ? "#000" : "#fff";
      c.fillRect(x, y, 1, 1);
    }
});
// Lopsided and partly transparent, so a flipped, misplaced or unpremultiplied draw shows.
const art = canvas(32, 32, (c) => {
  c.fillStyle = "#e33";
  c.fillRect(0, 0, 32, 8);
  c.fillStyle = "rgba(40,120,255,0.5)";
  c.fillRect(0, 8, 12, 24);
  c.fillStyle = "#3d3";
  c.fillRect(20, 20, 12, 12);
});
const clone = () => canvas(32, 32, (c) => c.drawImage(art, 0, 0));
// Pixi only garbage-collects image sources (canvas ones never), so the GC check draws a loaded image.
const artImage = new Image();
artImage.src = art.toDataURL();
await artImage.decode();
const green = solid("#2d2");
const live = canvas(32, 32, () => {});
const nearest = (src: HTMLCanvasElement) => {
  const t = Texture.from(src);
  t.source.scaleMode = "nearest";
  return t;
};

const app = new Application();
await app.init({ width: W, height: H, preference: "webgl", background: "#202020", antialias: false, resolution: 1, autoStart: false });
document.body.appendChild(app.canvas);
const gl = (app.renderer as unknown as { gl: WebGL2RenderingContext }).gl;
const create = gl.createTexture.bind(gl);
gl.createTexture = () => {
  out.created++;
  return create();
};
const stage = app.stage;

/** A RenderContainer that draws with spryte, or nothing when spryte is off. */
function slot(render: (d: Draw) => void): Container {
  const c = new RenderContainer(() => {});
  if (spryteOn) spryteContainer(c, render);
  return c;
}

let frame = 0;
const perFrame: (() => void)[] = [];

const scenes: Record<string, () => void> = {
  /** Left: Pixi behind, spryte, Pixi in front. Right (x >= 340): Pixi only, drawn after spryte. */
  state() {
    const back = stage.addChild(new Sprite(Texture.from(solid("#d22"))));
    back.setSize(300, 300);
    back.position.set(10, 30);
    stage.addChild(
      slot((d) => {
        for (let i = 0; i < 4; i++) d.sprite(green, 60 + i * 60, 60, { scaleX: 2.5, scaleY: 2.5 });
        d.sprite(checker, 250, 250, { scaleX: 8, scaleY: 8, smooth: false });
        d.sprite(green, 200, 300, { tint: "#f80", scaleX: 3, scaleY: 3 });
        d.text(`spryte ${frame % 7}`, 30, 150, { font: "20px sans-serif" });
      }),
    );
    const front = stage.addChild(new Sprite(Texture.from(solid("#ee2"))));
    front.setSize(80, 80);
    front.position.set(110, 60);
    const a = stage.addChild(new Sprite(nearest(checker)));
    a.setSize(128, 128);
    a.position.set(340, 30);
    const b = stage.addChild(new Sprite(nearest(checker)));
    b.setSize(128, 128);
    b.position.set(490, 30);
    b.tint = 0x88ff88;
    const liveTex = Texture.from(live);
    const c = stage.addChild(new Sprite(liveTex));
    c.setSize(96, 96);
    c.position.set(360, 200);
    const d = stage.addChild(new Sprite(liveTex));
    d.setSize(64, 64);
    d.position.set(440, 220);
    d.blendMode = "add";
    stage.addChild(new Graphics().circle(580, 260, 40).fill(0x3366ff));
    const txt = stage.addChild(new Text({ text: "", style: { fontSize: 20, fill: "#fff" } }));
    txt.position.set(350, 320);
    perFrame.push(() => {
      txt.text = `frame ${frame % 2}`;
      // A Pixi canvas texture with partial alpha re-uploaded every frame, after spryte's own uploads.
      const ctx = live.getContext("2d") as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, 32, 32);
      ctx.fillStyle = "rgba(255,128,0,0.5)";
      ctx.fillRect(0, 0, 32, 16);
      ctx.fillStyle = "rgba(0,200,255,0.25)";
      ctx.fillRect(0, 16, 32, 16);
      liveTex.source.update();
    });
  },

  /** `art` through a moved render group and a rotated, scaled container: spryte, or a Pixi Sprite as reference. */
  match() {
    const group = stage.addChild(new Container({ isRenderGroup: true }));
    group.position.set(40, 20);
    const holder = group.addChild(new Container());
    holder.position.set(260, 140);
    holder.rotation = 0.4;
    holder.scale.set(3, 2);
    if (spryteOn) holder.addChild(slot((d) => d.sprite(art, 0, 0, { origin: [0, 0], smooth: false })));
    else holder.addChild(new Sprite(nearest(art)));
  },

  /** spryte fills the world inside a circle mask (stencil) and a rectangle mask. */
  mask() {
    const left = stage.addChild(new Container());
    left.addChild(slot((d) => d.rect(0, 0, 320, 360, "#2d2")));
    left.mask = stage.addChild(new Graphics().circle(160, 180, 100).fill(0xffffff));
    const right = stage.addChild(new Container());
    right.addChild(slot((d) => d.rect(320, 0, 320, 360, "#2d2")));
    right.mask = stage.addChild(new Graphics().rect(400, 100, 160, 120).fill(0xffffff));
  },

  /** A green spryte square at (100..140, 60..100), through a grayscale filter on its container. */
  filter() {
    const back = stage.addChild(new Sprite(Texture.from(solid("#d22"))));
    back.setSize(100, 100);
    back.position.set(450, 200);
    const holder = stage.addChild(new Container());
    holder.addChild(slot((d) => d.sprite(green, 120, 80, { scaleX: 2.5, scaleY: 2.5 })));
    const f = new ColorMatrixFilter();
    f.grayscale(1, false);
    holder.filters = [f];
    // A RenderContainer has no bounds of its own, so the filter needs to be told where to work.
    holder.filterArea = new Rectangle(60, 20, 200, 160);
  },

  /** `art` drawn by spryte into a RenderTexture, shown by a Pixi Sprite at (200, 100), 4x. */
  target() {
    const rt = RenderTexture.create({ width: 32, height: 32 });
    rt.source.scaleMode = "nearest";
    const inner = new Container();
    inner.addChild(slot((d) => d.sprite(art, 0, 0, { origin: [0, 0], smooth: false })));
    perFrame.push(() => app.renderer.render({ container: inner, target: rt, clear: true }));
    const shown = stage.addChild(new Sprite(rt));
    shown.position.set(200, 100);
    shown.scale.set(4);
  },

  /** spryte draws an image Pixi holds through every path that samples a texture; share=0 draws copies. */
  borrow() {
    // Pixi draws the image in both runs, so it holds a texture for it either way.
    const pixiArt = stage.addChild(new Sprite(nearest(art)));
    pixiArt.position.set(600, 320);
    const img = share ? art : clone();
    const pos = new Float32Array([340, 60, 400, 90, 460, 60]);
    const rot = new Float32Array([0.3, -0.5, 1.2]);
    stage.addChild(
      slot((d) => {
        d.sprite(img, 60, 60, { scaleX: 3, scaleY: 3, smooth: false });
        d.sprite({ image: img, x: 16, y: 0, w: 16, h: 16 }, 60, 220, { scaleX: 6, scaleY: 6, smooth: false });
        d.sprites({ image: img, x: 0, y: 8, w: 32, h: 24 }, pos, 3, { scaleX: 1.5, scaleY: 1.5, smooth: false });
        d.sprites(img, pos, 3, { smooth: false }, { rotation: rot });
      }),
    );
  },

  /** Pixi draws `art` once, then hides it; spryte keeps drawing it. Pixi's texture GC must not free it. */
  gc() {
    const t = Texture.from(artImage);
    t.source.scaleMode = "nearest";
    const pixiArt = stage.addChild(new Sprite(t));
    pixiArt.position.set(600, 320);
    perFrame.push(() => {
      if (frame > 1) pixiArt.visible = false;
    });
    stage.addChild(slot((d) => d.sprite(artImage, 60, 60, { scaleX: 3, scaleY: 3, smooth: false })));
  },
};
scenes[sceneName]?.();
out.gc = () => {
  const gc = (app.renderer as unknown as { gc: { maxUnusedTime: number; run(): void } }).gc;
  gc.maxUnusedTime = 50;
  gc.run();
};

out.render = (n) => {
  for (let i = 0; i < n; i++) {
    frame++;
    for (const f of perFrame) f();
    app.render();
  }
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return Array.from(buf);
};
out.ready = true;
