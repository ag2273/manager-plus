import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** The screens alone, for the Tauri app (#72): served in dev, built into out/web. */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "../../out/web", emptyOutDir: true },
});
