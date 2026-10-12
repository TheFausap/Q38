import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error Vite config loads the JS middleware directly
import { createApi } from "./server/api.mjs";

function q38Api(): Plugin {
  return {
    name: "q38-api",
    configureServer(server) {
      server.middlewares.use(createApi());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApi());
    },
  };
}

export default defineConfig({
  plugins: [react(), q38Api()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: true,
  },
});
