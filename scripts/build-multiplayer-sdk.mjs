import { mkdir, writeFile } from "node:fs/promises";
import { builtInGameResources } from "../packages/games/build.mjs";
import { browserSdkResources } from "../packages/sdk/build.mjs";

// Bundle at build time; installed apps do not need an esbuild binary to set up a game.
const directory = new URL("../dist/multiplayer-sdk/", import.meta.url);
await mkdir(directory, { recursive: true });
const [sdk, games] = await Promise.all([browserSdkResources(), builtInGameResources()]);
await writeFile(new URL("resources.json", directory), JSON.stringify({ sdk, games }));
console.log("Prepared the browser multiplayer SDK.");
