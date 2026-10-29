// Scenes for check.mjs: each URL draws one situation with Phaser 4 and spryte, and exposes the frame's pixels.
//   scene = state | filter | viewport | stencil | shaders | borrow
//   share = 0 (borrow: spryte draws its own copies of Phaser's images) | 1
//   spryte = 0 (the Extern draws nothing) | 1
//   ctx = gl2 (createPhaserContext) | gl1 (Phaser's own WebGL1 context, for a reference render)
//   filter = extern | camera; smooth = 1 (render.smoothPixelArt)
import Phaser from "phaser";
import { createPhaserContext, spryteExtern } from "spryte/phaser";

const q = new URLSearchParams(location.search);
const sceneName = q.get("scene") ?? "state";
const spryteOn = q.get("spryte") !== "0";
const W = 640;
const H = 360;

const out = {
  ready: false,
  frames: 0,
  parity: 0,
  errors: [] as string[],
  pixels: null as Uint8Array | null,
  created: 0,
  wantPixels: false,
  game: null as Phaser.Game | null,
};
(window as unknown as { __check: typeof out }).__check = out;
window.addEventListener("error", (e) => out.errors.push(String(e.message)));
const warn = console.warn;
console.warn = (...a: unknown[]) => {
  out.errors.push(`warn: ${a.join(" ")}`);
  warn(...a);
};

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
const dot = canvas(8, 8, (c) => {
  c.fillStyle = "#4af";
  c.beginPath();
  c.arc(4, 4, 3.5, 0, Math.PI * 2);
  c.fill();
});
const green = solid("#2d2");
const live = canvas(32, 32, () => {});
const NM = 64;
const normalMap = canvas(NM, NM, (c) => {
  const img = c.createImageData(NM, NM);
  for (let i = 0; i < NM * NM; i++) {
    const nx = ((i % NM) % 16) - 7.5;
    const ny = (Math.floor(i / NM) % 16) - 7.5;
    const nz = Math.sqrt(Math.max(0, 64 - nx * nx - ny * ny));
    img.data.set([(nx / 8 + 1) * 127.5, (ny / 8 + 1) * 127.5, (nz / 8 + 1) * 127.5, 255], i * 4);
  }
  c.putImageData(img, 0, 0);
});
let seed = 1;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const POS = new Float32Array(20000);
for (let i = 0; i < 10000; i++) {
  POS[i * 2] = 20 + rnd() * 270;
  POS[i * 2 + 1] = 120 + rnd() * 220;
}

// Lopsided and partly transparent, so a flipped or unpremultiplied texture shows. `share=0` draws copies Phaser
// doesn't know, which spryte uploads itself.
const art = canvas(32, 32, (c) => {
  c.fillStyle = "#e33";
  c.fillRect(0, 0, 32, 8);
  c.fillStyle = "rgba(40,120,255,0.5)";
  c.fillRect(0, 8, 12, 24);
  c.fillStyle = "#3d3";
  c.fillRect(20, 20, 12, 12);
});
const artUrl = art.toDataURL();
const clone = () => canvas(32, 32, (c) => c.drawImage(art, 0, 0));
const share = q.get("share") !== "0";
let createdTextures = 0;

let frameNo = 0;

class Check extends Phaser.Scene {
  preload() {
    if (sceneName === "borrow") this.load.image("artImg", artUrl);
  }

  liveTex!: Phaser.Textures.CanvasTexture;

  extern(depth: number, render: (draw: import("spryte").Draw) => void): Phaser.GameObjects.Extern {
    const ext = this.add.extern().setDepth(depth);
    if (spryteOn) spryteExtern(ext, render);
    else ext.render = () => {};
    return ext;
  }

  create() {
    const t = this.textures;
    t.addCanvas("red", solid("#d22"));
    t.addCanvas("yellow", solid("#ee2"));
    t.addCanvas("checker", checker);
    t.get("checker").setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.liveTex = t.addCanvas("live", live) as Phaser.Textures.CanvasTexture;
    ({
      state: this.state,
      filter: this.filter,
      viewport: this.viewport,
      stencil: this.stencil,
      shaders: this.shaders,
      borrow: this.borrow,
    })[sceneName]?.call(this);

    const gl = (this.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
    this.game.events.on("postrender", () => {
      out.frames++;
      if (out.wantPixels) {
        const buf = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        out.pixels = buf;
        out.parity = frameNo % 2;
        out.created = createdTextures;
        out.wantPixels = false;
      }
    });
    this.events.on("update", () => frameNo++);
    out.ready = true;
  }

  /** Left: Phaser behind, spryte, Phaser in front. Right (x >= 340): Phaser only, drawn after spryte. */
  state() {
    this.add.image(160, 180, "red").setDisplaySize(300, 300).setDepth(0);
    this.extern(1, (d) => {
      for (let i = 0; i < 4; i++) d.sprite(green, 60 + i * 60, 60, { scaleX: 2.5, scaleY: 2.5 });
      d.sprites(dot, POS, 10000);
      d.sprite(checker, 250, 250, { scaleX: 8, scaleY: 8, smooth: false });
      d.sprite(green, 200, 300, { tint: "#f80", scaleX: 3, scaleY: 3 });
      d.text(`spryte ${frameNo % 7}`, 30, 150, { font: "20px sans-serif" });
    });
    this.add.image(150, 100, "yellow").setDisplaySize(80, 80).setDepth(2);
    this.add.image(400, 90, "checker").setDisplaySize(128, 128).setDepth(3);
    this.add.image(560, 90, "checker").setDisplaySize(128, 128).setDepth(3).setTint(0x88ff88);
    this.add.image(420, 250, "live").setDisplaySize(96, 96).setDepth(3);
    this.add.image(470, 260, "live").setDisplaySize(64, 64).setDepth(3).setBlendMode(Phaser.BlendModes.ADD);
    this.add.graphics().setDepth(3).fillStyle(0x3366ff, 1).fillCircle(580, 260, 40);
    const txt = this.add.text(350, 320, "", { fontSize: "20px", color: "#fff" }).setDepth(3);
    this.events.on("update", () => {
      txt.setText(`frame ${frameNo % 2}`);
      // A Phaser canvas texture with partial alpha re-uploaded every frame, after spryte's own uploads.
      const c = live.getContext("2d") as CanvasRenderingContext2D;
      c.clearRect(0, 0, 32, 32);
      c.fillStyle = "rgba(255,128,0,0.5)";
      c.fillRect(0, 0, 32, 16);
      c.fillStyle = "rgba(0,200,255,0.25)";
      c.fillRect(0, 16, 32, 16);
      this.liveTex.refresh();
    });
  }

  /** A green spryte square at (100..140, 60..100), through a grayscale filter on the Extern or the camera. */
  filter() {
    this.add.image(500, 250, "red").setDisplaySize(100, 100).setDepth(0);
    const ext = this.extern(1, (d) => d.sprite(green, 120, 80, { scaleX: 2.5, scaleY: 2.5 }));
    if (q.get("filter") === "camera") this.cameras.main.filters.internal.addColorMatrix().colorMatrix.grayscale();
    else {
      ext.enableFilters();
      ext.filters?.internal.addColorMatrix().colorMatrix.grayscale();
    }
  }

  /** Two cameras with viewports; spryte fills the world. Nothing may land outside the viewports. */
  viewport() {
    this.add.image(320, 180, "red").setDisplaySize(640, 360).setDepth(0);
    this.extern(1, (d) => d.rect(0, 0, 640, 360, "#2d2"));
    const main = this.cameras.main.setViewport(20, 20, 280, 320).setBackgroundColor(0x000000);
    main.centerOn(320, 180);
    this.cameras.add(340, 100, 280, 160).setZoom(0.4).setBackgroundColor(0x000000).centerOn(320, 180);
  }

  /** A Stencil over the band y 120..240; spryte fills the world after it. */
  stencil() {
    const band = new Phaser.GameObjects.Rectangle(this, 320, 180, 640, 120, 0xffffff);
    this.add.stencil(0, 0, [band]).setDepth(0.5);
    this.extern(1, (d) => d.rect(0, 0, 640, 360, "#2d2"));
  }

  /** spryte draws images Phaser holds (loaded, and a canvas texture) through every path that samples a texture. */
  borrow() {
    this.textures.addCanvas("artCanvas", art);
    const loaded = share ? (this.textures.get("artImg").getSourceImage() as HTMLImageElement) : clone();
    const own = share ? art : clone();
    const pos = new Float32Array([340, 60, 400, 90, 460, 60]);
    const rot = new Float32Array([0.3, -0.5, 1.2]);
    this.extern(1, (d) => {
      d.sprite(loaded, 60, 60, { scaleX: 3, scaleY: 3, smooth: false });
      d.sprite(own, 180, 60, { scaleX: 3, scaleY: 3, smooth: false, tint: "#8f8" });
      d.sprite({ image: loaded, x: 16, y: 0, w: 16, h: 16 }, 60, 220, { scaleX: 6, scaleY: 6, smooth: false });
      d.sprites({ image: own, x: 0, y: 8, w: 32, h: 24 }, pos, 3, { scaleX: 1.5, scaleY: 1.5, smooth: false });
      d.sprites(loaded, pos, 3, { smooth: false }, { rotation: rot });
    });
  }

  /** Phaser features whose shaders use derivatives, plus normal-mapped lighting, with spryte in the scene. */
  shaders() {
    (this.textures.addCanvas("rock", solid("#999", NM, NM)) as Phaser.Textures.CanvasTexture).setDataSource(normalMap);
    this.lights.enable().setAmbientColor(0x202020);
    this.lights.addLight(120, 90, 200, 0xffffff, 2);
    this.add.image(100, 100, "rock").setDisplaySize(128, 128).setLighting(true).setDepth(0);
    this.add.gradient(undefined, 240, 30, 160, 140).setOrigin(0).setDepth(0);
    (
      this.add as unknown as {
        noisesimplex2d: (config: object, x: number, y: number, w: number, h: number) => { setDepth(depth: number): unknown };
      }
    )
      .noisesimplex2d({ noiseNormalMap: true }, 500, 100, 160, 140)
      .setDepth(0);
    this.add.image(100, 280, "checker").setDisplaySize(120, 120).setDepth(0);
    this.extern(1, (d) => d.sprites(dot, POS, 2000));
    this.add.image(400, 280, "yellow").setDisplaySize(60, 60).setDepth(2);
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.WEBGL,
  width: W,
  height: H,
  backgroundColor: "#202020",
  scene: Check,
  banner: false,
  antialiasGL: false,
  render: { smoothPixelArt: q.get("smooth") === "1" },
};
if (q.get("ctx") !== "gl1") {
  const context = createPhaserContext(undefined, { antialias: false });
  const create = context.gl.createTexture.bind(context.gl);
  context.gl.createTexture = () => {
    createdTextures++;
    return create();
  };
  Object.assign(config, context);
}
out.game = new Phaser.Game(config);
