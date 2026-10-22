import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMultiplayerManifestConfig } from "../src/shared/multiplayer-protocol.js";

const [, , configPath, outputPath] = process.argv;
if (!configPath || !outputPath) {
  throw new Error(
    "Usage: bun scripts/build-multiplayer-example.ts <deployment.json> <output-directory>",
  );
}

const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
if (!isMultiplayerManifestConfig(config))
  throw new Error("The deployment manifest is invalid.");

const source = path.resolve("dist/player");
const destination = path.resolve(outputPath);
if (source === destination || destination.startsWith(`${source}${path.sep}`)) {
  throw new Error("Choose an output directory outside dist/player.");
}
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await writeFile(
  path.join(destination, "manifest.json"),
  `${JSON.stringify({ version: 1, runtime: "multiplayer-example", multiplayer: config }, null, 2)}\n`,
);
