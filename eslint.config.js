import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/", "dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The end-to-end journeys are plain Node scripts that drive the built app.
    files: ["e2e/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", __dirname: "readonly", process: "readonly", console: "readonly", window: "readonly", document: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Run with Node, as a one-off on the owner's PC.
    files: ["licence-server/*.mjs"],
    languageOptions: { globals: { process: "readonly", URL: "readonly" } },
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
