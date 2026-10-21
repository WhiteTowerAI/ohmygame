import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORY_WEB_ENTRY,
  storyWebEditorBridge,
  storyWebRuntimeModules,
} from "../src/daemon/story-web-bundle.js";

const execute = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function isolatedBuild() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-story-resources-"),
  );
  cleanups.push(directory);
  const daemon = path.join(directory, "dist/daemon");
  await mkdir(daemon, { recursive: true });
  const source = await readFile("src/daemon/story-web-bundle.ts", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const entry = path.join(daemon, "story-web-bundle.mjs");
  await writeFile(entry, compiled);
  return {
    directory,
    read: async () => {
      const { stdout } = await execute(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
        const bundle = await import(${JSON.stringify(pathToFileURL(entry).href)});
        console.log(JSON.stringify({
          modules: await bundle.storyWebRuntimeModules(),
          bridge: await bundle.storyWebEditorBridge(),
        }));
      `,
        ],
        { cwd: directory, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    },
  };
}

describe("built story resources", () => {
  it("loads readable modules and the bridge without source files or build dependencies", async () => {
    const fixture = await isolatedBuild();
    const resources = {
      modules: await storyWebRuntimeModules(),
      bridge: await storyWebEditorBridge(),
    };
    await mkdir(path.join(fixture.directory, "dist/story-web"));
    await writeFile(
      path.join(fixture.directory, "dist/story-web/resources.json"),
      JSON.stringify(resources),
    );

    expect(await fixture.read()).toEqual(resources);
    expect(resources.modules[STORY_WEB_ENTRY]).toContain(
      "The story runtime a web story project carries",
    );
    expect(resources.modules[STORY_WEB_ENTRY]).toContain(
      "../shared/playable-runtime.js",
    );
    expect(resources.modules["story/shared/playable-runtime.js"]).toBeDefined();
    expect(resources.bridge).toContain("ohmygame:playable:snapshot");
  });

  it("fails clearly when build resources are missing instead of compiling at runtime", async () => {
    const fixture = await isolatedBuild();
    await expect(fixture.read()).rejects.toThrow(
      "The web story resources are missing from this build.",
    );
  });
});
