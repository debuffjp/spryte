// Runs the GPU pixel checks in headless Chrome: node browser-test/run.mjs (SPRYTE_BROWSER=firefox or webkit for those)
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { createServer } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
await server.listen();
// SPRYTE_BROWSER=firefox or webkit runs Playwright's builds of those (npx playwright-core install firefox webkit).
// SPRYTE_ARGS adds Chrome flags; "--disable-gpu-compositing --disable-accelerated-2d-canvas" reproduces CI's software Canvas 2D.
const engine = process.env.SPRYTE_BROWSER;
const browser =
  engine === "firefox" || engine === "webkit"
    ? await { firefox, webkit }[engine].launch()
    : await chromium.launch({ channel: process.env.SPRYTE_BROWSER_CHANNEL ?? "chrome", args: process.env.SPRYTE_ARGS?.split(" ") ?? [] });
let failed = false;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    console.error(e);
    failed = true;
  });
  await page.goto(server.resolvedUrls.local[0]);
  const results = await page.waitForFunction(() => window.__checks, undefined, { timeout: 30_000 }).then((h) => h.jsonValue());
  for (const r of results) {
    // A blank render would also "match": require that something was drawn.
    const ok = r.differing === 0 && r.nonBackground > 100;
    if (!ok) failed = true;
    console.log(`${ok ? "pass" : "FAIL"}  ${r.name} (${r.differing} px differ, ${r.nonBackground} px drawn)`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
