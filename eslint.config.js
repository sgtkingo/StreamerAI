import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.flight/**",
      "**/.wrangler/**",
      "tmp/**",
      "apps/client/release/**",
      "apps/client/android/**/build/**",
      "apps/web/public/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: [
      "apps/server/**/*.{ts,tsx}",
      "packages/**/*.{ts,tsx}",
      "apps/client/src/{main,preload,settings,security}.ts",
      "apps/client/scripts/*.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "apps/web/src/**/*.{ts,tsx}",
      "apps/web/vite.config.ts",
      "apps/client/src/renderer.ts",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.vitest },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
