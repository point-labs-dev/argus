import js from "@eslint/js";

export default [
  {
    ignores: ["src/**", "tests/**", "dist/**", "scripts/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: [".cursor/skills/verify-argus/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
      },
    },
  },
];
