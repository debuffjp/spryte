// A Phaser 4 game whose bullets are drawn by spryte: one Extern between Phaser's background and its HUD.
// Run with `npm run example:phaser` in packages/spryte (after `npm install` here and `npm run build` at the root).
import Phaser from "phaser";
import { createPhaserContext, spryteExtern } from "spryte/phaser";

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

class Demo extends Phaser.Scene {
  create() {
    this.textures.addCanvas("ship", ship);
    this.add.grid(W / 2, H / 2, W, H, 40, 40, 0x1a1a2e, 1, 0x26264a, 1).setDepth(0);
    const hero = this.add.image(W / 2, H / 2, "ship").setDepth(2);
    this.tweens.add({ targets: hero, angle: 360, duration: 6000, repeat: -1 });
    const score = this.add.text(12, H - 32, "", { fontSize: "18px", color: "#fff" }).setDepth(2);

    // Everything spryte draws here sits at depth 1: over the grid, under the ship and the text.
    spryteExtern(this.add.extern().setDepth(1), (draw) => {
      draw.sprites(bullet, positions, N, { alpha: 0.9 });
    });

    this.events.on("update", (_t: number, dtMs: number) => {
      const dt = dtMs / 1000;
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
      score.setText(`${N.toLocaleString()} bullets by spryte, ${Math.round(this.game.loop.actualFps)} fps`);
    });
  }
}

new Phaser.Game({
  type: Phaser.WEBGL,
  ...createPhaserContext(),
  width: W,
  height: H,
  backgroundColor: "#111",
  scene: Demo,
});
