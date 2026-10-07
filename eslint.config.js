// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["client/**/*.ts"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["server/**/*.ts", "loadtest/**/*.ts", "shared/**/*.ts", "*.js", "*.ts"],
    languageOptions: { globals: globals.node },
  },
);
