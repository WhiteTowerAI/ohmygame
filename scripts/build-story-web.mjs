import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  STORY_WEB_ENTRY,
  storyWebEditorBridge,
  storyWebRuntimeModules,
} from "../src/daemon/story-web-bundle.ts";

// Build from source before packaging, where esbuild can still read the module
// graph. Keep runtime modules readable; only the editor bridge is bundled.
const directory = new URL("../dist/story-web/", import.meta.url);
const destination = new URL("resources.json", directory);
await mkdir(directory, { recursive: true });
await rm(destination, { force: true });
const [modules, bridge] = await Promise.all([
  storyWebRuntimeModules(),
  storyWebEditorBridge(),
]);
if (!modules[STORY_WEB_ENTRY] || !bridge.trim()) {
  throw new Error("The web story build produced incomplete resources.");
}
await writeFile(destination, JSON.stringify({ modules, bridge }));
console.log(
  `Prepared ${Object.keys(modules).length} story runtime modules and the editor bridge.`,
);
