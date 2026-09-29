import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: path.resolve(
        import.meta.dirname,
        "src/renderer/playable-sandbox-entry.ts",
      ),
      formats: ["iife"],
      name: "OhMyGamePlayableSandbox",
      fileName: () => "assets/playable-sandbox.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
