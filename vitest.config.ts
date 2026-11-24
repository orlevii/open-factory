import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/harness/testing/*.test.ts",
            "apps/server/src/**/*.test.ts",
            "apps/server/scripts/*.test.ts",
            "apps/cli/src/**/*.test.ts",
          ],
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
      "apps/web",
    ],
  },
});
