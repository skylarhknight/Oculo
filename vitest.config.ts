import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/mobile/src/**/*.test.{ts,tsx}",
      "apps/account-functions/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "apps/mobile/ios/**", "apps/mobile/android/**"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
