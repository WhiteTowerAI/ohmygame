import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(repositoryRoot, "src/community-web"),
  plugins: [
    react(),
    {
      name: "community-dev-csp",
      transformIndexHtml: {
        order: "post",
        handler(html, ctx) {
          if (ctx.server) {
            return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, "");
          }
          return html;
        },
      },
    },
  ],
  build: {
    outDir: path.join(repositoryRoot, "dist/community-web"),
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:43130",
      "/account-api": {
        target: process.env.OPEN_GAME_PORTAL_URL ?? "http://127.0.0.1:43150",
        rewrite: (path) => path.replace(/^\/account-api/, "/api"),
      },
    },
  },
});
