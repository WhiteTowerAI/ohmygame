import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const { Platform, PlatformPackager } = require("app-builder-lib");
const {
  createUpdateInfoTasks,
  writeUpdateInfoFiles,
} = require("app-builder-lib/out/publish/updateInfoBuilder.js");

it.each([
  [Platform.WINDOWS, "exe", "latest.yml"],
  [Platform.MAC, "zip", "latest-mac.yml"],
])(
  "puts changelog notes in the %s update manifest",
  async (platform, extension, manifest) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-release-feed-"),
    );
    try {
      const version = "0.0.0-beta.4.7";
      const notes = "### Fixed\n\n- Restore interrupted previews.\n";
      const config = parse(await readFile("electron-builder.yml", "utf8"));
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ version }),
      );
      await writeFile(
        path.join(directory, "CHANGELOG.md"),
        `## [${version}] - 2026-10-14\n\n${notes}`,
      );
      const result = spawnSync(
        "node",
        [
          path.resolve("scripts/release-notes.mjs"),
          "--output",
          config.releaseInfo.releaseNotesFile,
        ],
        {
          cwd: directory,
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const artifact = path.join(directory, `OhMyGame.${extension}`);
      await writeFile(artifact, "installer fixture");
      const packager = {
        config,
        platform,
        projectDir: directory,
        platformSpecificBuildOptions: {},
        appInfo: { version },
        info: { buildResourcesDir: path.join(directory, "build") },
        resourceList: Promise.resolve([]),
        getResource: PlatformPackager.prototype.getResource,
        emitArtifactCreated: async () => {},
      };
      const tasks = await createUpdateInfoTasks(
        { file: artifact, packager, target: { outDir: directory } },
        [
          {
            provider: "generic",
            url: "https://updates.example.test/desktop",
            channel: "latest",
          },
        ],
      );
      await writeUpdateInfoFiles(tasks, packager);
      const feed = parse(
        await readFile(path.join(directory, manifest), "utf8"),
      );
      expect(feed.version).toBe(version);
      expect(feed.releaseNotes).toBe(notes);
      expect(feed.files[0].url).toBe(path.basename(artifact));
      expect(feed.files[0].sha512).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
