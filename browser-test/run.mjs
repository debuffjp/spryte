// Runs the GPU pixel checks in headless Chrome: node browser-test/run.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { port: 0 } });
await server.listen();
const browser = await chromium.launch({ channel: process.env.SPRYTE_BROWSER_CHANNEL ?? "chrome" });
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
    console.log(`${ok ? "pass" : "FAIL"}  sprites() == sprite() loop: ${r.name} (${r.differing} px differ, ${r.nonBackground} px drawn)`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
