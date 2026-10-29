// Real-GPU checks of spryte inside PixiJS v8, in headless Chrome: node examples/pixi/check.mjs
// `spryte` resolves to ../../src here, so the checks cover the source in this checkout. The example's TypeScript is
// checked against Pixi's types first, so the structural types in spryte/pixi stay compatible.
// SPRYTE_BROWSER=firefox or webkit runs Playwright's builds of those.
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
  server: { port: 0, fs: { allow: [spryte, join(spryte, "..", "..", "node_modules")] } },
  resolve: { alias: { "spryte/pixi": join(spryte, "src", "pixi.ts"), spryte: join(spryte, "src", "index.ts") } },
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

  /** Open a scene, render `frames` frames and return the last one's pixels, the errors and the textures created. */
  async function run(params, frames = 4) {
    pageErrors.length = 0;
    await page.goto(`${base}?${new URLSearchParams(params)}`);
    await page.waitForFunction(() => window.__check?.ready, undefined, { timeout: 30_000 });
    const px = Uint8Array.from(await page.evaluate((n) => window.__check.render(n), frames));
    const [errors, created] = await page.evaluate(() => [window.__check.errors.slice(0, 3), window.__check.created]);
    return { px, errors: [...pageErrors, ...errors], created };
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
  const errs = (...lists) => lists.flat().join(" | ") || "none";
  const isGreen = (c) => c[1] > 150 && c[0] < 100;

  // Pixi objects drawn after spryte are pixel-identical to a run where the container draws nothing.
  {
    const off = await run({ scene: "state", spryte: "0" });
    const on = await run({ scene: "state", spryte: "1" });
    const n = differing(on.px, off.px, 340, 0, W, H);
    check(
      "Pixi after spryte == Pixi alone (nearest, tint, ADD, Graphics, Text, re-uploaded alpha texture)",
      n === 0 && !off.errors.length && !on.errors.length,
      `${n} px differ; errors: ${errs(off.errors, on.errors)}`,
    );
    check(
      "spryte drew where expected, between Pixi's sprites",
      isGreen(at(on.px, 70, 70)) && at(on.px, 140, 80)[0] > 200 && at(on.px, 140, 80)[1] > 200,
      `at (70,70): ${at(on.px, 70, 70)}, under the front sprite: ${at(on.px, 140, 80)}`,
    );
  }

  // The same image through a render group and a rotated, scaled container lands where a Pixi Sprite does.
  {
    const pixi = await run({ scene: "match", spryte: "0" });
    const ours = await run({ scene: "match", spryte: "1" });
    const drawn = count(pixi.px, (c) => c[0] !== 0x20 || c[1] !== 0x20 || c[2] !== 0x20);
    const n = differing(ours.px, pixi.px, 0, 0, W, H, 2);
    check(
      "spryte's transform == Pixi's (render group, rotation, non-uniform scale)",
      n <= drawn * 0.005 && drawn > 3000 && !pixi.errors.length && !ours.errors.length,
      `${n} of ${drawn} drawn px differ by > 2; errors: ${errs(pixi.errors, ours.errors)}`,
    );
  }

  // A circle mask (stencil) and a rectangle mask clip spryte.
  {
    const { px, errors } = await run({ scene: "mask" });
    const inCircle = (x, y) => (x - 160) ** 2 + (y - 180) ** 2 <= 99 ** 2;
    const nearCircle = (x, y) => Math.abs(Math.hypot(x - 160, y - 180) - 100) < 2;
    const inRect = (x, y) => x >= 400 && x < 560 && y >= 100 && y < 220;
    const outside = count(px, (c, x, y) => isGreen(c) && !inCircle(x, y) && !nearCircle(x, y) && !inRect(x, y));
    const circle = count(px, (c, x, y) => isGreen(c) && inCircle(x, y));
    const rect = count(px, (c, x, y) => isGreen(c) && inRect(x, y));
    check(
      "masks clip spryte (circle and rectangle)",
      outside === 0 && circle > 30000 && rect === 160 * 120 && !errors.length,
      `${outside} px outside, ${circle} in the circle, ${rect}/${160 * 120} in the rectangle, errors: ${errs(errors)}`,
    );
  }

  // A filter on the container: spryte draws into Pixi's filter texture, in place and the right way up.
  {
    const { px, errors } = await run({ scene: "filter" });
    const isGray = (c) => Math.abs(c[0] - c[1]) < 14 && Math.abs(c[1] - c[2]) < 14 && c[0] > 70;
    const inside = count(px, isGray, 100, 60, 140, 100);
    const outside = count(px, isGray, 0, 0, 250, 160) - inside;
    check(
      "grayscale filter on the container: spryte's square is gray, in place",
      inside === 1600 && outside === 0 && !errors.length,
      `${inside}/1600 inside, ${outside} outside, red sprite ${at(px, 500, 250)}, errors: ${errs(errors)}`,
    );
  }

  // Into a RenderTexture: the image comes out the right way up when Pixi shows the texture.
  {
    const { px, errors } = await run({ scene: "target" });
    const top = at(px, 200 + 64, 100 + 8);
    const corner = at(px, 200 + 104, 100 + 104);
    check(
      "spryte into a RenderTexture, shown by Pixi the right way up",
      top[0] > 200 && top[1] < 80 && isGreen(corner) && !errors.length,
      `top row ${top}, bottom-right ${corner}, errors: ${errs(errors)}`,
    );
  }

  // Images Pixi holds draw from Pixi's textures exactly as from spryte's own uploads, with one fewer texture.
  {
    const copied = await run({ scene: "borrow", share: "0" });
    const shared = await run({ scene: "borrow", share: "1" });
    const n = differing(shared.px, copied.px);
    const top = at(shared.px, 60, 20);
    check(
      "spryte draws Pixi's own textures, no second copy",
      n === 0 && copied.created - shared.created === 1 && top[0] > 200 && top[1] < 80 && !copied.errors.length && !shared.errors.length,
      `${n} px differ, ${copied.created - shared.created} fewer textures created, top of the sprite ${top}, errors: ${errs(copied.errors, shared.errors)}`,
    );
  }

  // Pixi stops drawing an image spryte still draws: Pixi's texture GC must not free the texture under spryte.
  {
    const before = await run({ scene: "gc" });
    const after = Uint8Array.from(
      await page.evaluate(async () => {
        window.__check.render(1);
        await new Promise((r) => setTimeout(r, 200));
        window.__check.gc();
        return window.__check.render(2);
      }),
    );
    const n = differing(after, before.px, 0, 0, 300, 200);
    check(
      "Pixi's texture GC keeps textures only spryte draws",
      n === 0 && at(after, 60, 20)[0] > 200 && !before.errors.length,
      `${n} px changed after a GC pass, top of the sprite ${at(after, 60, 20)}, errors: ${errs(before.errors)}`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}
for (const r of results) console.log(`${r.ok ? "pass" : "FAIL"}  ${r.name} (${r.detail})`);
process.exit(failed ? 1 : 0);
