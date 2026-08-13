import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(repositoryRoot, "src/community-web"),
  plugins: [react()],
  build: {
    outDir: path.join(repositoryRoot, "dist/community-web"),
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
    proxy: {
      "/v1": "http://127.0.0.1:43130",
    },
  },
});
