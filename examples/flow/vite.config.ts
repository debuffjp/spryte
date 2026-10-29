import { defineConfig } from "vite";

// Cross-origin isolation, so the river's fluid can share memory between several workers
// (SharedArrayBuffer). "credentialless" still lets the page load the spryte icon from debuff.jp.
// Browsers without it (or a host without these headers) fall back to a single worker.
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  server: { headers },
  preview: { headers },
});
