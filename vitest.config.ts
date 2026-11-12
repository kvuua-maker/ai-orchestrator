import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/tests/**/*.test.ts", "apps/**/src/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
