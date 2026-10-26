import { mkdir, writeFile } from "node:fs/promises";
import { buildMultiplayerSdkResources } from "../src/daemon/multiplayer-sdk.ts";

// Bundle at build time; installed apps do not need an esbuild binary to set up a game.
const directory = new URL("../dist/multiplayer-sdk/", import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL("resources.json", directory),
  JSON.stringify(await buildMultiplayerSdkResources()),
);
console.log("Prepared the browser multiplayer SDK.");
