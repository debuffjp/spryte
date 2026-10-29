// Real-GPU checks of spryte inside Phaser 4, in headless Chrome: node examples/phaser/check.mjs
// Needs `npm install` in this folder (Phaser). `spryte` resolves to ../../src here, so the checks cover the source
// in this checkout. The example's TypeScript is checked against Phaser's types first, so the structural types in
// spryte/phaser stay compatible. SPRYTE_BROWSER=firefox or webkit runs Playwright's builds of those.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { createServer } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const spryte = join(root, "..", "..");
const W = 640;
const H = 360;

const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");
execFileSync(process.execPath, [tsc, "--noEmit", "-p", root], { stdio: "inherit" });

const server = await createServer({
  root,
  logLevel: "error",
  server: { port: 0, fs: { allow: [spryte] } },
  resolve: { alias: { "spryte/phaser": join(spryte, "src", "phaser.ts"), spryte: join(spryte, "src", "index.ts") } },
});
await server.listen();
const engine = process.env.SPRYTE_BROWSER;
const browser =
  engine === "firefox" || engine === "webkit"
    ? await { firefox, webkit }[engine].launch()
    : await chromium.launch({ channel: process.env.SPRYTE_BROWSER_CHANNEL ?? "chrome", args: ["--ignore-gpu-blocklist"] });
const results = [];
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message.split("\n")[0]));
  const base = `${server.resolvedUrls.local[0]}check.html`;

  async function open(params, frames = 30) {
    pageErrors.length = 0;
    await page.goto(`${base}?${new URLSearchParams(params)}`);
    await page.waitForFunction(() => window.__check?.ready, undefined, { timeout: 30_000 });
    await page.waitForFunction((n) => window.__check.frames >= n, frames, { timeout: 60_000 });
    const errors = await page.evaluate(() => window.__check.errors.slice(0, 3));
    return [...pageErrors, ...errors];
  }
  async function pixels() {
    await page.evaluate(() => {
      window.__check.wantPixels = true;
    });
    await page.waitForFunction(() => window.__check.pixels, undefined, { timeout: 10_000 });
    const [arr, parity] = await page.evaluate(() => {
      const p = Array.from(window.__check.pixels);
      window.__check.pixels = null;
      return [p, window.__check.parity];
    });
    return { px: Uint8Array.from(arr), parity };
  }
  // readPixels rows are bottom-up; (x, y) is top-down here.
  const at = (px, x, y) => {
    const i = ((H - 1 - y) * W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const count = (px, test, x0 = 0, y0 = 0, x1 = W, y1 = H) => {
    let n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(at(px, x, y), x, y)) n++;
    return n;
  };
  const differing = (a, b, x0 = 0, y0 = 0, x1 = W, y1 = H, tolerance = 0) =>
    count(a, (c, x, y) => Math.max(...c.map((v, i) => Math.abs(v - at(b, x, y)[i]))) > tolerance, x0, y0, x1, y1);
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failed = true;
  };
  const isGreen = (c) => c[1] > 150 && c[0] < 100;

  // Phaser objects drawn after spryte are pixel-identical to a run where the Extern draws nothing.
  {
    const errors = await open({ scene: "state", spryte: "0" }, 40);
    const bases = {};
    while (bases[0] === undefined || bases[1] === undefined) {
      const { px, parity } = await pixels();
      bases[parity] = px;
    }
    const errors2 = await open({ scene: "state", spryte: "1" }, 40);
    const { px, parity } = await pixels();
    const n = differing(px, bases[parity], 340, 0, W, H);
    check(
      "Phaser after spryte == Phaser alone (nearest, tint, ADD, Graphics, Text, re-uploaded alpha texture)",
      n === 0 && !errors.length && !errors2.length,
      `${n} px differ; errors: ${[...errors, ...errors2].join(" | ") || "none"}`,
    );
    check(
      "spryte drew where expected",
      isGreen(at(px, 70, 70)) && at(px, 140, 80)[0] > 200,
      `at (70,70): ${at(px, 70, 70)}, under the front image: ${at(px, 140, 80)}`,
    );
  }

  // Filters on the Extern and on the camera: spryte draws into Phaser's filter framebuffer, in place.
  for (const filter of ["extern", "camera"]) {
    const errors = await open({ scene: "filter", filter });
    const { px } = await pixels();
    const isGray = (c) => Math.abs(c[0] - c[1]) < 14 && Math.abs(c[1] - c[2]) < 14 && c[0] > 70;
    const inside = count(px, isGray, 100, 60, 140, 100);
    const outside = count(px, isGray, 0, 0, 250, 160) - inside;
    const red = at(px, 500, 250);
    check(
      `grayscale filter on the ${filter}: spryte's square is gray, in place`,
      inside === 1600 && outside === 0 && !errors.length,
      `${inside}/1600 inside, ${outside} outside, Phaser image ${red}, errors: ${errors.join(" | ") || "none"}`,
    );
  }

  // Two cameras with viewports: spryte fills each viewport and nothing outside them.
  {
    const errors = await open({ scene: "viewport" });
    const { px } = await pixels();
    const inMain = (x, y) => x >= 20 && x < 300 && y >= 20 && y < 340;
    const inMini = (x, y) => x >= 340 && x < 620 && y >= 100 && y < 260;
    const outside = count(px, (c, x, y) => isGreen(c) && !inMain(x, y) && !inMini(x, y));
    const main = count(px, (c, x, y) => isGreen(c) && inMain(x, y));
    const mini = count(px, (c, x, y) => isGreen(c) && inMini(x, y));
    check(
      "camera viewports clip spryte",
      outside === 0 && main > 80000 && mini > 30000 && !errors.length,
      `${outside} px outside, ${main} in the main camera, ${mini} in the minimap, errors: ${errors.join(" | ") || "none"}`,
    );
  }

  // A Stencil mask: spryte draws only where the stencil allows.
  {
    const errors = await open({ scene: "stencil" });
    const { px } = await pixels();
    const band = count(px, isGreen, 0, 120, W, 240);
    const outside = count(px, isGreen) - band;
    check(
      "Stencil masks spryte",
      band === 0 && outside === 640 * 240 && !errors.length,
      `${band} px in the masked band, ${outside}/${640 * 240} outside, errors: ${errors.join(" | ") || "none"}`,
    );
  }

  // Images Phaser holds draw from Phaser's textures (flipped, premultiplied) exactly as from spryte's own uploads,
  // through single sprites, frames, batches and per-copy rotation, with two fewer textures created.
  {
    const e1 = await open({ scene: "borrow", share: "0" });
    const copied = await pixels();
    const created0 = await page.evaluate(() => window.__check.created);
    const e2 = await open({ scene: "borrow", share: "1" });
    const shared = await pixels();
    const created1 = await page.evaluate(() => window.__check.created);
    const n = differing(shared.px, copied.px);
    const top = at(shared.px, 60, 20);
    check(
      "spryte draws Phaser's own textures, no second copy",
      n === 0 && created0 - created1 === 2 && top[0] > 200 && top[1] < 80 && !e1.length && !e2.length,
      `${n} px differ, ${created0 - created1} fewer textures created, top of the sprite ${top}, errors: ${[...e1, ...e2].join(" | ") || "none"}`,
    );
  }

  // Phaser's derivative-using shaders (Gradient, noise normal map, smoothPixelArt) and lighting on the WebGL2
  // context from createPhaserContext render as they do on Phaser's own WebGL1 context; then, with spryte drawing
  // in the scene, everything Phaser draws around it is unchanged.
  for (const smooth of ["0", "1"]) {
    const e1 = await open({ scene: "shaders", ctx: "gl1", spryte: "0", smooth });
    const gl1 = (await pixels()).px;
    const e2 = await open({ scene: "shaders", ctx: "gl2", spryte: "0", smooth });
    const gl2 = (await pixels()).px;
    const e3 = await open({ scene: "shaders", ctx: "gl2", spryte: "1", smooth });
    const withSpryte = (await pixels()).px;
    const parity = differing(gl2, gl1, 0, 0, W, H, 1);
    const drawn = count(gl2, (c) => c[0] !== 0x20 || c[1] !== 0x20 || c[2] !== 0x20, 240, 30, 400, 170);
    // spryte's dots cover x 20..290, y 120..340: compare the rest.
    const around = differing(withSpryte, gl2, 300, 0, W, H) + differing(withSpryte, gl2, 0, 0, 300, 115);
    check(
      `shaders on WebGL2 == WebGL1 (smoothPixelArt ${smooth})`,
      parity === 0 && drawn > 1000 && !e1.length && !e2.length,
      `${parity} px differ by > 1, gradient drew ${drawn} px, errors: ${[...e1, ...e2].join(" | ") || "none"}`,
    );
    check(
      `lit and shader objects unchanged around spryte (smoothPixelArt ${smooth})`,
      around === 0 && !e3.length,
      `${around} px differ, errors: ${e3.join(" | ") || "none"}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name} (${r.detail})`);
process.exit(failed ? 1 : 0);
