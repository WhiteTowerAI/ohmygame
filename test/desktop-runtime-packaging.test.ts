import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Configuration } from "app-builder-lib";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const require = createRequire(import.meta.url);
const {
  copyFiles,
  getFileMatchers,
} = require("app-builder-lib/out/fileMatcher.js");

describe("desktop runtime packaging", () => {
  it.each([
    [
      "win",
      [
        "node.exe",
        "npm.cmd",
        "node_modules/npm/bin/npm-cli.js",
        "node_modules/npm/bin/npm-prefix.js",
        "node_modules/npm/node_modules/semver/package.json",
        "node_modules/corepack/dist/corepack.js",
      ],
    ],
    [
      "mac",
      [
        "bin/node",
        "bin/npm",
        "lib/node_modules/npm/bin/npm-cli.js",
        "lib/node_modules/npm/node_modules/semver/package.json",
        "lib/node_modules/corepack/dist/corepack.js",
      ],
    ],
  ] as const)(
    "preserves the %s runtime without copying other build files",
    async (platform, files) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "ohmygame-packaging-"),
      );
      try {
        const config = parse(
          await readFile("electron-builder.yml", "utf8"),
        ) as Configuration;
        const runtimeFiles = [...files, ".ohmygame-node-version"];
        const sharedFiles = {
          "plugins/skill.txt": "plugins/skill.txt",
          ".runtime/preinstalled-plugins/skill.txt":
            "preinstalled-plugins/skill.txt",
          ".runtime/examples/catalog.json": "examples/catalog.json",
          ".runtime/desktop-config.json": "desktop-config.json",
        };
        const sourceFiles = [
          ...runtimeFiles.map((file) => `.runtime/node/${file}`),
          ...Object.keys(sharedFiles),
          ".runtime/node-archive.zip",
          ".runtime/typebox/index.mjs",
        ];
        for (const file of sourceFiles) {
          const target = path.join(directory, file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, file);
        }
        const resources = path.join(directory, "resources");
        await copyFiles(
          getFileMatchers(config, "extraResources", resources, {
            defaultSrc: directory,
            macroExpander: (value: string) => value,
            customBuildOptions: config[platform] ?? {},
            globalOutDir: path.join(directory, "release"),
          }),
        );
        for (const file of runtimeFiles) {
          expect(
            await readFile(path.join(resources, "runtime/node", file), "utf8"),
          ).toBe(`.runtime/node/${file}`);
        }
        for (const [source, destination] of Object.entries(sharedFiles)) {
          expect(
            await readFile(path.join(resources, destination), "utf8"),
          ).toBe(source);
        }
        expect(await readdir(path.join(resources, "runtime"))).toEqual([
          "node",
        ]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
