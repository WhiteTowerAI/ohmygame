import { createRequire } from "node:module";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

// Keep TypeBox's public entry points and package metadata intact while sharing
// their implementation in a few chunks instead of hundreds of ESM files.
export default async function prepareDesktopTypeBox({ packager }) {
  const appDirectory = packager.info.appDir;
  const require = createRequire(path.join(appDirectory, "package.json"));
  const buildDirectory = path.dirname(require.resolve("typebox"));
  const packageDirectory = path.dirname(buildDirectory);
  const metadata = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const outputDirectory = path.join(appDirectory, ".runtime", "typebox");

  await rm(outputDirectory, { recursive: true, force: true });
  await build({
    entryPoints: Object.values(metadata.exports).map((entry) =>
      path.join(packageDirectory, entry.import),
    ),
    outbase: buildDirectory,
    outdir: outputDirectory,
    outExtension: { ".js": ".mjs" },
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    minify: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
}
