import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "player",
  base: "./",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: "../dist/player",
    emptyOutDir: true,
  },
});
