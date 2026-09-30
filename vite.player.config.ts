import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "player",
  base: "./",
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../dist/player",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "player/index.html"),
        playableSandbox: path.resolve(import.meta.dirname, "player/playable-sandbox.html"),
      },
    },
  },
});
