import { defineConfig } from "vitest/config";

// Used when spryte is checked out on its own; inside the debuff monorepo the root config runs these tests.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "happy-dom" } });
