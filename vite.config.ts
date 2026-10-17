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
  build: {
    rolldownOptions: {
      output: {
        /* Third-party code in its own chunks: each stays under the 500 kB
           warning, and they keep their hashes (so the browser keeps them
           cached) when only Q38's own code changes. */
        codeSplitting: {
          groups: [
            { name: "katex", test: /[\\/]node_modules[\\/]katex[\\/]/ },
            { name: "highlight", test: /[\\/]node_modules[\\/]highlight\.js[\\/]/ },
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "vendor", test: /[\\/]node_modules[\\/]/ },
          ],
        },
      },
    },
  },
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
