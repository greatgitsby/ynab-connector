import { defineConfig } from "vitest/config";

// Capability evals from real agent runs. Kept out of `npm test`: they are
// expected to fail until the tools improve.
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
  },
});
