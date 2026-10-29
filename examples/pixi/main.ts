// A PixiJS v8 app whose bullets are drawn by spryte: one RenderContainer between Pixi's background and its HUD.
// Run with `npm run example:pixi` in packages/spryte (after `npm run build` at the root).
import { Application, Graphics, RenderContainer, Sprite, Text, Texture } from "pixi.js";
import { spryteContainer } from "spryte/pixi";

const W = 800;
const H = 450;
const N = 50_000;

// Textures made at runtime, so the example has no assets.
function canvas(w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  paint(c.getContext("2d") as CanvasRenderingContext2D);
  return c;
}
const bullet = canvas(6, 6, (c) => {
  c.fillStyle = "#ffd36b";
  c.beginPath();
  c.arc(3, 3, 3, 0, Math.PI * 2);
  c.fill();
});
const ship = canvas(32, 32, (c) => {
  c.fillStyle = "#8cf";
  c.beginPath();
  c.moveTo(16, 2);
  c.lineTo(30, 30);
  c.lineTo(16, 22);
  c.lineTo(2, 30);
  c.closePath();
  c.fill();
});

const positions = new Float32Array(N * 2);
const velocities = new Float32Array(N * 2);
for (let i = 0; i < N; i++) {
  const angle = Math.random() * Math.PI * 2;
  const speed = 20 + Math.random() * 120;
  positions[i * 2] = W / 2;
  positions[i * 2 + 1] = H / 2;
  velocities[i * 2] = Math.cos(angle) * speed;
  velocities[i * 2 + 1] = Math.sin(angle) * speed;
}

const app = new Application();
await app.init({ width: W, height: H, preference: "webgl", background: "#1a1a2e" });
document.body.appendChild(app.canvas);

const grid = new Graphics();
for (let x = 0; x <= W; x += 40) grid.moveTo(x, 0).lineTo(x, H);
for (let y = 0; y <= H; y += 40) grid.moveTo(0, y).lineTo(W, y);
app.stage.addChild(grid.stroke({ color: 0x26264a, width: 1 }));

// Everything spryte draws sits here in the scene: over the grid, under the ship and the text.
app.stage.addChild(spryteContainer(new RenderContainer({}), (draw) => draw.sprites(bullet, positions, N, { alpha: 0.9 })));

const hero = app.stage.addChild(new Sprite(Texture.from(ship)));
hero.anchor.set(0.5);
hero.position.set(W / 2, H / 2);
const score = app.stage.addChild(new Text({ text: "", style: { fontSize: 18, fill: "#fff" } }));
score.position.set(12, H - 32);

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS / 1000;
  hero.rotation += dt;
  for (let i = 0; i < N * 2; i += 2) {
    let x = (positions[i] as number) + (velocities[i] as number) * dt;
    let y = (positions[i + 1] as number) + (velocities[i + 1] as number) * dt;
    if (x < 0 || x > W) {
      velocities[i] = -(velocities[i] as number);
      x = Math.min(W, Math.max(0, x));
    }
    if (y < 0 || y > H) {
      velocities[i + 1] = -(velocities[i + 1] as number);
      y = Math.min(H, Math.max(0, y));
    }
    positions[i] = x;
    positions[i + 1] = y;
  }
  score.text = `${N.toLocaleString()} bullets by spryte, ${Math.round(ticker.FPS)} fps`;
});
