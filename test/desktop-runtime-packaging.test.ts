import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPackage, extractFile } from "@electron/asar";
import type { Configuration } from "app-builder-lib";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const { isolateDesktopArchive } = await import(
  pathToFileURL(path.resolve("scripts/isolated-desktop-archive.mjs")).href
);

const require = createRequire(import.meta.url);
const {
  copyFiles,
  getFileMatchers,
} = require("app-builder-lib/out/fileMatcher.js");

describe("desktop runtime packaging", () => {
  it("does not resolve missing packaged dependencies from the build checkout", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-isolated-archive-"));
    try {
      const checkout = path.join(directory, "checkout");
      const dependency = path.join(checkout, "node_modules", "missing-packaged-dependency");
      await mkdir(dependency, { recursive: true });
      await writeFile(path.join(dependency, "package.json"), JSON.stringify({ name: "missing-packaged-dependency", main: "index.js" }));
      await writeFile(path.join(dependency, "index.js"), "module.exports = 1;");
      const app = path.join(checkout, "release", "resources");
      await mkdir(app, { recursive: true });
      const source = path.join(directory, "archive-source");
      await mkdir(source);
      await writeFile(path.join(source, "package.json"), '{"name":"packaged-fixture"}');
      const archive = path.join(app, "app.asar");
      await createPackage(source, archive);
      await vi.waitFor(() => expect(extractFile(archive, "package.json").toString()).toContain("packaged-fixture"));
      const entry = path.join("dist", "daemon", "server.js");
      const resolved = createRequire(path.join(archive, entry)).resolve("missing-packaged-dependency");
      expect(await realpath(resolved)).toBe(await realpath(path.join(dependency, "index.js")));

      const isolated = await isolateDesktopArchive(archive, path.join(directory, "isolated"));
      expect(extractFile(isolated, "package.json").toString()).toContain("packaged-fixture");
      expect(() => createRequire(path.join(isolated, entry)).resolve("missing-packaged-dependency")).toThrow(/Cannot find module/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps unpacked runtime files beside the isolated archive", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-unpacked-archive-"));
    try {
      const archive = path.join(directory, "app.asar");
      await writeFile(archive, "archive fixture");
      const relative = path.join("node_modules", "fixture", "native.node");
      const native = path.join(`${archive}.unpacked`, relative);
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, "native fixture");

      const isolated = await isolateDesktopArchive(archive, path.join(directory, "isolated"));
      expect(await readFile(isolated, "utf8")).toBe("archive fixture");
      expect(await readFile(path.join(`${isolated}.unpacked`, relative), "utf8")).toBe("native fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("includes the generated story resources and template licenses in the application", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-story-packaging-"));
    try {
      const config = parse(await readFile("electron-builder.yml", "utf8")) as Configuration;
      const relative = "dist/story-web/resources.json";
      await mkdir(path.join(directory, "dist/story-web"), { recursive: true });
      await writeFile(path.join(directory, relative), "story resources");
      const notices = await Promise.all(["NOTICE.txt", "LICENSE.txt"].map(async (name) => {
        const contents = await readFile(path.join("src/daemon/assets/scene-templates", name));
        const relative = `dist/daemon/assets/scene-templates/${name}`;
        await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
        await writeFile(path.join(directory, relative), contents);
        return {
          archivePath: path.join("dist", "daemon", "assets", "scene-templates", name),
          relative,
          contents,
        };
      }));
      const destination = path.join(directory, "app");
      const matchers = getFileMatchers(config, "files", destination, {
        defaultSrc: directory,
        macroExpander: (value: string) => value,
        customBuildOptions: {},
        globalOutDir: path.join(directory, "release"),
      });
      await copyFiles(matchers.filter((matcher: { from: string }) => matcher.from === directory));
      expect(await readFile(path.join(destination, relative), "utf8")).toBe("story resources");
      const archive = path.join(directory, "app.asar");
      await createPackage(destination, archive);
      // ASAR's promise can resolve before its output stream has finished writing.
      await vi.waitFor(() => {
        expect(extractFile(archive, path.join("dist", "story-web", "resources.json")).toString()).toBe("story resources");
        for (const { archivePath, contents } of notices) {
          expect(extractFile(archive, archivePath)).toEqual(contents);
        }
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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
          "integrations/skills/ohmygame-studio/SKILL.md":
            "integrations/skills/ohmygame-studio/SKILL.md",
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
