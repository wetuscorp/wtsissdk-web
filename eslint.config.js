import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "examples/**/dist/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/spa-tracker.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/unbound-method": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "examples/**/*.ts"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-undef": "off",
    },
  },
);
