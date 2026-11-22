import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/", "dist/", "node_modules/", "target/", "src-tauri/gen/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The end-to-end journeys are plain Node scripts that drive the built app.
    files: ["e2e/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", __dirname: "readonly", process: "readonly", console: "readonly", window: "readonly", document: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // The Tauri journey: a Node script that drives the app over WebDriver.
    files: ["e2e/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly", URL: "readonly", Buffer: "readonly", window: "readonly", document: "readonly", Event: "readonly" } },
  },
  {
    // Run with Node, as a one-off on the owner's PC.
    files: ["licence-server/*.mjs", "scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly", URL: "readonly", Buffer: "readonly" } },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["electron", "react", "react-dom", "*/main/*", "*/renderer/*", "*/preload/*"] },
      ],
    },
  },
);
