import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "artifacts/**",
      "**/node_modules/**",
      "apps/mobile/ios/**",
      "apps/mobile/android/**",
      "apps/mobile/build/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["tools/**/*.mjs"],
    languageOptions: { ecmaVersion: "latest", globals: globals.node },
  },
  prettier,
);
