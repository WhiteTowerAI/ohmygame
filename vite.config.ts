import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
    watch: { ignored: ["**/.data/**", "**/dist/**"] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:43110",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
