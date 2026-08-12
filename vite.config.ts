import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: false,
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
