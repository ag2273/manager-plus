import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/", "dist/", "node_modules/", "target/", "src-tauri/gen/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The end-to-end journeys: Node scripts that drive the built app over WebDriver.
    files: ["e2e/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly", URL: "readonly", Buffer: "readonly", window: "readonly", document: "readonly", Event: "readonly" } },
  },
  {
    // Run with Node, as a one-off on the owner's PC.
    files: ["licence-server/*.mjs", "scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly", URL: "readonly", Buffer: "readonly" } },
  },
  {
    // The screens' contract with the Rust core is types only; the core's rules never run here.
    files: ["src/shared/**/*.ts", "src/renderer/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: ["node:*", "better-sqlite3"] }] },
  },
);
