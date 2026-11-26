import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  STORY_WEB_ENTRY,
  storyWebRuntimeModules,
} from "../src/daemon/story-web-bundle.ts";

// Build from source before packaging, where esbuild can still read the module
// graph. Keep runtime modules readable.
const directory = new URL("../dist/story-web/", import.meta.url);
const destination = new URL("resources.json", directory);
await mkdir(directory, { recursive: true });
await rm(destination, { force: true });
const modules = await storyWebRuntimeModules();
if (!modules[STORY_WEB_ENTRY]) {
  throw new Error("The web story build produced incomplete resources.");
}
await writeFile(destination, JSON.stringify({ modules }));
// Presets read their files and illustrations in both source development and the built daemon.
for (const folder of ["story-templates", "scene-templates"]) {
  await cp(
    new URL(`../src/daemon/assets/${folder}/`, import.meta.url),
    new URL(`../dist/daemon/assets/${folder}/`, import.meta.url),
    { recursive: true },
  );
}
console.log(
  `Prepared ${Object.keys(modules).length} story runtime modules.`,
);
