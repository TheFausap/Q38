import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Builds the whole app for jsdom, so `tests/memory-ui.mjs` can drive the real
 * workbench instead of a mock of it. Nothing here ships: the output lands in
 * tests/.bundle, which is git-ignored.
 */
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  ssr: { noExternal: true },
  build: {
    ssr: true,
    minify: false,
    outDir: fileURLToPath(new URL(".bundle", import.meta.url)),
    emptyOutDir: true,
  },
});
