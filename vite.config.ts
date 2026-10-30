/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { parseChangelog } from "./src/shared/changelog.js";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};
// Release builds upload hidden source maps to Sentry and delete them, so packages never ship them.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_CHANGELOG__: JSON.stringify(parseChangelog(readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8"))),
  },
  plugins: [
    react(),
    sentryAuthToken
      ? sentryVitePlugin({
          org: "whitetower-hk-limited",
          project: "ohmygame",
          authToken: sentryAuthToken,
          telemetry: false,
          // Matches the release @sentry/electron reports by default.
          release: { name: `${packageJson.name}@${packageJson.version}`, inject: false },
          sourcemaps: { filesToDeleteAfterUpload: ["dist/renderer/**/*.map"] },
        })
      : undefined,
  ],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: sentryAuthToken ? "hidden" : false,
    rolldownOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        webGameHost: path.resolve(import.meta.dirname, "web-game-host.html"),
      },
    },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/provider-environment.ts", "test/dom-environment.ts"],
    // Real compiler builds and grammar initialization need bounded parallelism on Bun.
    maxWorkers: 4,
    // Playable build tests run real esbuild/vite builds and exceed the 5s default under parallel load.
    testTimeout: 30_000,
    // Polls that wait for spawned processes need more than the 1s default under parallel load.
    expect: { poll: { timeout: 10_000 } },
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
