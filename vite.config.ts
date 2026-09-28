import { readFileSync } from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { build as buildWithEsbuild } from "esbuild";
import { defineConfig, type Plugin } from "vite";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  plugins: [playableSandboxDevPlugin(), react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        playableSandbox: path.resolve(import.meta.dirname, "playable-sandbox.html"),
      },
    },
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

function playableSandboxDevPlugin(): Plugin {
  const html = readFileSync(
    new URL("./playable-sandbox.html", import.meta.url),
    "utf8",
  );
  const entry = path.resolve(
    import.meta.dirname,
    "src/renderer/playable-sandbox-entry.ts",
  );
  return {
    name: "playable-sandbox-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(
          request.url ?? "/",
          "http://localhost",
        ).pathname;
        if (pathname === "/playable-sandbox.html") {
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
          return;
        }
        if (pathname !== "/assets/playable-sandbox.js") {
          next();
          return;
        }
        try {
          const result = await buildWithEsbuild({
            entryPoints: [entry],
            bundle: true,
            charset: "utf8",
            format: "iife",
            platform: "browser",
            sourcemap: "inline",
            target: "es2022",
            write: false,
          });
          const javascript = result.outputFiles[0]?.text;
          if (!javascript) throw new Error("Sandbox build produced no output.");
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader(
            "Content-Type",
            "text/javascript; charset=utf-8",
          );
          response.end(javascript);
        } catch (cause) {
          server.config.logger.error(
            cause instanceof Error ? cause.message : String(cause),
          );
          response.statusCode = 500;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Playable sandbox could not be built.");
        }
      });
    },
  };
}
