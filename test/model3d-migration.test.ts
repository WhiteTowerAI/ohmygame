import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODEL3D_MIGRATION_PACKAGES,
  model3DMigrationPackageIssue,
} from "../src/daemon/model3d-migration-package.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";
import { MODEL_3D_PRESETS } from "../src/shared/model3d-presets.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  model3DSettingsFiles,
  pluginModel3DDefinition,
  proposeModel3DSettings,
} from "../src/daemon/model3d-migration-settings.js";
import { snapshot as settingsSnapshot } from "../src/daemon/media-settings-snapshot.js";
import { rehearseModel3DMigration } from "../scripts/rehearse-model3d-migration.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { PluginMediaProviders } from "../src/daemon/plugin-media-providers.js";
import { PluginMediaModelChoices } from "../src/daemon/plugin-media-models.js";

describe.each(MODEL3D_MIGRATION_PACKAGES)(
  "$provider reviewed Beta migration package",
  (pin) => {
    async function fixture(
      check: (directory: string, root: string) => Promise<void>,
    ) {
      const directory = await mkdtemp(
        path.join(tmpdir(), "model3d-migration-"),
      );
      const root = path.join(
        directory,
        "plugin-store/packages",
        pin.id,
        pin.version,
      );
      try {
        await cp(
          path.resolve(
            ".runtime",
            `${pin.pluginId}-packages`,
            pin.version,
            "source",
          ),
          root,
          { recursive: true },
        );
        const index = new PluginIndex(
          path.join(directory, "plugin-store/index.json"),
        );
        const result = await index.add(root);
        if (!result.ok) throw new Error("Invalid prepared 3D package");
        expect(result.entry.digest).toBe(pin.digest);
        await writeFile(
          path.join(directory, "plugin-store/origins.json"),
          JSON.stringify({
            [`${pin.id}@${pin.version}`]: {
              type: "npm",
              package: pin.package,
              version: pin.version,
              registry: "npmjs",
            },
          }),
        );
        await writeFile(
          path.join(directory, "plugin-store/grants.json"),
          JSON.stringify({
            schema: 2,
            plugins: {
              [pin.id]: {
                enabled: true,
                everyProject: true,
                allowed: capabilityGrants(result.entry.manifest),
              },
            },
            projects: {},
          }),
        );
        await writeFile(
          path.join(directory, `${pin.provider}.json`),
          JSON.stringify({
            version: 1,
            apiKey: "private-canary",
            future: { retain: true },
          }),
        );
        await check(directory, root);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    async function snapshot(directory: string) {
      const files = await readdir(directory, {
        recursive: true,
        withFileTypes: true,
      });
      return Object.fromEntries(
        await Promise.all(
          files
            .filter((file) => file.isFile())
            .map(async (file) => {
              const name = path.join(file.parentPath, file.name);
              return [
                path.relative(directory, name),
                (await readFile(name)).toString("base64"),
              ];
            }),
        ),
      );
    }

    it("accepts the actual published package with native presets while leaving all profile bytes unchanged", async () => {
      await fixture(async (directory, root) => {
        const manifest = JSON.parse(
          await readFile(
            path.join(root, ".ohmygame-plugin/plugin.json"),
            "utf8",
          ),
        );
        expect(manifest.beta).toBe(true);
        const provider = manifest.contributes.providers.find(
          (entry: { id: string }) => entry.id === pin.provider,
        );
        expect(provider.apiKey).toBe("apiKey");
        expect(manifest.configuration.apiKey.type).toBe("secret");
        const media = provider.media["3d"];
        expect(media).toMatchObject({
          inputFiles: true,
          editableModels: true,
          balance: true,
          maxMinutes: 60,
        });
        expect(media.models.map((model: { id: string }) => model.id)).toEqual(
          MODEL_3D_PRESETS[pin.provider].map((model) => model.id),
        );
        for (const preset of MODEL_3D_PRESETS[pin.provider]) {
          const model = media.models.find(
            (model: { id: string }) => model.id === preset.id,
          );
          expect(model.polycount).toEqual(preset.settings.polycount);
          expect(model.maxReferenceImages).toBe(
            preset.settings.maxReferenceImages,
          );
          expect(model.texture).toBe(preset.settings.supportsTexture);
          expect(model.pbr).toBe(preset.settings.supportsPbr);
        }
        const before = await snapshot(directory);
        expect(
          await model3DMigrationPackageIssue(directory, pin.provider),
        ).toBeUndefined();
        expect(await snapshot(directory)).toEqual(before);
        const prepared = JSON.parse(
          await readFile(".runtime/preinstalled-plugins/index.json", "utf8"),
        );
        expect(
          prepared.plugins.some((entry: { id: string }) => entry.id === pin.id),
        ).toBe(false);
      });
    });

    const target = `plugin.ohmygame.${pin.provider}.${pin.provider}`;
    const files = model3DSettingsFiles(pin.provider);
    const custom = {
      ...structuredClone(MODEL_3D_PRESETS[pin.provider][0]!),
      id: "my-private-model",
      name: "private-model-canary",
    };
    custom.settings.polycount = {
      ...custom.settings.polycount,
      default: 2000,
      presets: [1000, 2000],
    };
    custom.settings.defaults = { texture: false, pbr: false };
    async function seed(directory: string) {
      await writeFile(
        path.join(directory, "model-visibility.json"),
        JSON.stringify({
          version: 1,
          hidden: {
            [pin.provider]: [custom.id, "future-hidden"],
            unrelated: ["keep"],
          },
          disabled: [pin.provider, "unrelated"],
          nativeModels3D: { [pin.provider]: [custom] },
          defaultModel3D: {
            provider: pin.provider,
            id: custom.id,
            future: "reference-metadata",
          },
          future: { retained: true },
        }),
      );
      await writeFile(
        path.join(directory, "plugin-store/configuration.json"),
        JSON.stringify({
          version: 1,
          plugins: {
            unrelated: {
              token: {
                type: "secret",
                value: "other-private-canary",
                extra: true,
              },
            },
          },
          future: true,
        }),
      );
      await writeFile(
        path.join(directory, "plugin-media-models.json"),
        JSON.stringify({
          version: 1,
          providers: { unrelated: { future: { retain: "opaque" } } },
          future: { preserve: true },
        }),
      );
    }
    async function declared(root: string) {
      return JSON.parse(
        await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8"),
      ).contributes.providers[0].media["3d"].models;
    }

    it("rehearses custom models, keys, visibility and defaults with source preservation and rollback", async () => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const before = await settingsSnapshot(directory, files);
        const plan = await proposeModel3DSettings(
          before,
          pin.provider,
          await declared(root),
        );
        expect(plan.report.blockers).toEqual([]);
        expect(plan.counts).toEqual({
          keys: 1,
          definitions: 1,
          providerPreferences: 1,
          defaultModel3D: true,
          modelStoreUpgrade: true,
        });
        expect(plan.changes.has(files[0])).toBe(false);
        const config = JSON.parse(plan.changes.get(files[1])!.toString());
        expect(config.plugins[pin.id].apiKey).toEqual({
          type: "secret",
          value: "private-canary",
        });
        expect(config.plugins.unrelated.token.extra).toBe(true);
        const prefs = JSON.parse(plan.changes.get(files[2])!.toString());
        expect(prefs.disabled).toEqual([pin.provider, "unrelated", target]);
        expect(prefs.defaultModel3D).toEqual({
          provider: target,
          id: custom.id,
          future: "reference-metadata",
        });
        expect(prefs.nativeModels3D[pin.provider]).toEqual([custom]);
        expect(prefs.future).toEqual({ retained: true });
        const models = JSON.parse(plan.changes.get(files[3])!.toString());
        expect(models.version).toBe(2);
        expect(models.future).toEqual({ preserve: true });
        expect(models.providers.unrelated).toEqual({
          future: { retain: "opaque" },
        });
        expect(models.providers[target]["3d"].hidden).toEqual([
          custom.id,
          "future-hidden",
        ]);
        expect(models.providers[target]["3d"].definitions[0]).toEqual({
          custom: true,
          model: pluginModel3DDefinition(pin.provider, custom),
        });
        const after = new Map([...before, ...plan.changes]);
        expect(
          (
            await proposeModel3DSettings(
              after,
              pin.provider,
              await declared(root),
            )
          ).changes.size,
        ).toBe(0);
        expect(JSON.stringify(plan.report)).not.toMatch(
          /private-canary|private-model-canary|other-private/,
        );
        expect(await settingsSnapshot(directory, files)).toEqual(before);
        const report = await rehearseModel3DMigration(directory, pin.provider);
        expect(report).toMatchObject({
          status: "passed",
          activation: "held",
          checks: {
            reload: true,
            idempotent: true,
            rollback: true,
            sourceUnchanged: true,
            cleanup: true,
          },
        });
        expect(await settingsSnapshot(directory, files)).toEqual(before);
        expect(JSON.stringify(report)).not.toContain("private-canary");
      });
    });

    it("loads staged custom definitions through the actual published plugin catalog", async () => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const plan = await proposeModel3DSettings(
          await settingsSnapshot(directory, files),
          pin.provider,
          await declared(root),
        );
        expect(plan.report.blockers).toEqual([]);
        for (const [file, bytes] of plan.changes)
          await writeFile(path.join(directory, file), bytes!);
        const services = new PluginServices({
          directory: path.join(directory, "plugin-store"),
        });
        const choices = new PluginMediaModelChoices(directory);
        const media = new PluginMediaProviders(
          services,
          async () => {
            throw new Error("No vendor requests allowed");
          },
          undefined,
          choices,
          directory,
        );
        try {
          let catalog = (await media.model3DProviders()).find(
            (p) => p.id === target,
          )!;
          expect(catalog.models.some((model) => model.id === custom.id)).toBe(
            false,
          );
          await media.setModelsShown(target, "3d", [custom.id], true);
          catalog = (await media.model3DProviders()).find(
            (p) => p.id === target,
          )!;
          const model = catalog.models.find((model) => model.id === custom.id)!;
          expect(model.name).toBe(custom.name);
          expect(model.polycount.default).toBe(2000);
          expect(model.defaults).toEqual({ texture: false, pbr: false });
          expect(model.maxReferenceImages).toBe(
            custom.settings.maxReferenceImages,
          );
        } finally {
          await media.close();
          await services.close();
        }
      });
    });

    it("preserves preset overrides and matching target metadata without overwriting later choices", async () => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const presets = structuredClone(MODEL_3D_PRESETS[pin.provider]);
        const edited = presets[0]!;
        edited.name = "Edited preset";
        edited.settings.polycount = {
          ...edited.settings.polycount,
          default: 2000,
          presets: [1000, 2000],
        };
        edited.settings.defaults = { texture: false, pbr: false };
        const prefsFile = path.join(directory, files[2]);
        const prefs = JSON.parse(await readFile(prefsFile, "utf8"));
        prefs.nativeModels3D[pin.provider].push(edited);
        await writeFile(prefsFile, JSON.stringify(prefs));
        const before = await settingsSnapshot(directory, files);
        const plan = await proposeModel3DSettings(
          before,
          pin.provider,
          await declared(root),
        );
        expect(plan.report.blockers).toEqual([]);
        const after = new Map([...before, ...plan.changes]);
        const models = JSON.parse(after.get(files[3])!.toString());
        const definitions = models.providers[target]["3d"].definitions;
        expect(
          definitions.find((entry: any) => entry.model.id === edited.id),
        ).toMatchObject({
          custom: false,
          model: {
            title: "Edited preset",
            polycount: { default: 2000 },
            defaults: { texture: false, pbr: false },
          },
        });
        definitions[0].model.data = { opaque: ["preserve", 1] };
        models.providers[target]["3d"].future = { retain: true };
        after.set(files[3], Buffer.from(JSON.stringify(models)));
        const config = JSON.parse(after.get(files[1])!.toString());
        config.plugins[pin.id].apiKey.future = { retain: true };
        after.set(files[1], Buffer.from(JSON.stringify(config)));
        const repeated = await proposeModel3DSettings(
          after,
          pin.provider,
          await declared(root),
        );
        expect(repeated.report.blockers).toEqual([]);
        expect(repeated.changes.size).toBe(0);
        const equivalentNames = JSON.parse(after.get(files[2])!.toString());
        equivalentNames.nativeModels3D[pin.provider][0].name = custom.id;
        after.set(files[2], Buffer.from(JSON.stringify(equivalentNames)));
        delete definitions[0].model.title;
        after.set(files[3], Buffer.from(JSON.stringify(models)));
        const unnamed = await proposeModel3DSettings(
          after,
          pin.provider,
          await declared(root),
        );
        expect(unnamed.report.blockers).toEqual([]);
        expect(unnamed.changes.size).toBe(0);
      });
    });

    it("reports a Node rehearsal without credential output and refuses an apply option", async () => {
      await fixture(async (directory) => {
        await seed(directory);
        const before = await settingsSnapshot(directory, files);
        const run = (args: string[]) =>
          promisify(execFile)("node", [
            "--conditions=ohmygame-source",
            "--import",
            "tsx",
            "scripts/rehearse-model3d-migration.ts",
            ...args,
          ]);
        const { stdout, stderr } = await run([
          "--provider",
          pin.provider,
          "--data-dir",
          directory,
        ]);
        expect(JSON.parse(stdout)).toMatchObject({
          status: "passed",
          checks: { rollback: true, sourceUnchanged: true },
        });
        expect(stdout).not.toContain("private-canary");
        expect(stderr).toBe("");
        await expect(
          run([
            "--provider",
            pin.provider,
            "--data-dir",
            directory,
            "--apply",
            "private-canary",
          ]),
        ).rejects.toMatchObject({
          code: 2,
          stdout: "",
          stderr: expect.not.stringContaining("private-canary"),
        });
        expect(await settingsSnapshot(directory, files)).toEqual(before);
      });
    });

    it.each([
      ["legacy-version", "legacy-settings-unreadable"],
      ["plugin-version", "plugin-models-unreadable"],
      ["future-model", "unsupported-model-definition"],
      ["key", "key-conflict"],
      ["definition", "model-definition-conflict"],
      ["visibility", "visibility-conflict"],
      ["processing", "processing-model-conflict"],
      ["default", "default-model-unsupported"],
    ])(
      "holds the whole settings plan for %s without leaking source data",
      async (failure, expected) => {
        await fixture(async (directory, root) => {
          await seed(directory);
          const edit = async (file: string, change: (data: any) => void) => {
            const location = path.join(directory, file),
              value = JSON.parse(await readFile(location, "utf8"));
            change(value);
            await writeFile(location, JSON.stringify(value));
          };
          if (failure === "legacy-version")
            await edit(files[0], (v) => {
              v.version = 99;
            });
          if (failure === "plugin-version")
            await edit(files[3], (v) => {
              v.version = 99;
            });
          if (failure === "future-model")
            await edit(files[2], (v) => {
              v.nativeModels3D[pin.provider][0].settings.future =
                "unknown-behavior";
            });
          if (failure === "key")
            await edit(files[1], (v) => {
              v.plugins[pin.id] = {
                apiKey: { type: "secret", value: "conflicting-private-key" },
              };
            });
          if (failure === "definition")
            await edit(files[3], (v) => {
              v.version = 2;
              const converted = pluginModel3DDefinition(pin.provider, custom);
              converted.polycount.default = 4000;
              v.providers[target] = {
                "3d": {
                  added: [],
                  hidden: [custom.id, "future-hidden"],
                  definitions: [{ custom: true, model: converted }],
                },
              };
            });
          if (failure === "visibility")
            await edit(files[2], (v) => {
              v.hidden[target] = [];
            });
          if (failure === "processing")
            await edit(files[2], (v) => {
              v.nativeModels3D[pin.provider][0].id = "connection";
            });
          if (failure === "default")
            await edit(files[2], (v) => {
              v.defaultModel3D.id = "unknown-default";
            });
          const before = await settingsSnapshot(directory, files);
          const plan = await proposeModel3DSettings(
            before,
            pin.provider,
            await declared(root),
          );
          expect(plan.report.blockers).toContain(expected);
          expect(plan.changes.size).toBe(0);
          expect(JSON.stringify(plan.report)).not.toMatch(
            /private-canary|private-model-canary|conflicting-private-key/,
          );
          expect(await settingsSnapshot(directory, files)).toEqual(before);
        });
      },
    );

    it.each([
      ["bytes", "plugin-package-mismatch"],
      ["metadata", "plugin-index-mismatch"],
      ["disabled", "plugin-not-enabled"],
      ["scope", "plugin-not-enabled"],
      ["permissions", "plugin-permissions-missing"],
      ["source", "plugin-source-not-reviewed"],
    ])(
      "refuses %s without modifying the package, settings or grants",
      async (failure, expected) => {
        await fixture(async (directory, root) => {
          const edit = async (name: string, change: (value: any) => void) => {
            const file = path.join(directory, "plugin-store", name);
            const value = JSON.parse(await readFile(file, "utf8"));
            change(value);
            await writeFile(file, JSON.stringify(value));
          };
          if (failure === "bytes")
            await writeFile(
              path.join(root, "media/adapter.js"),
              "changed package",
            );
          if (failure === "metadata")
            await edit("index.json", (value) => {
              value.entries[0].manifest.description = "changed cached metadata";
            });
          if (failure === "disabled")
            await edit("grants.json", (value) => {
              value.plugins[pin.id].enabled = false;
            });
          if (failure === "scope")
            await edit("grants.json", (value) => {
              value.plugins[pin.id].everyProject = false;
            });
          if (failure === "permissions")
            await edit("grants.json", (value) => {
              value.plugins[pin.id].allowed = [];
            });
          if (failure === "source")
            await edit("origins.json", (value) => {
              value[`${pin.id}@${pin.version}`].type = "development";
            });
          const before = await snapshot(directory);
          expect(
            await model3DMigrationPackageIssue(directory, pin.provider),
          ).toBe(expected);
          expect(await snapshot(directory)).toEqual(before);
        });
      },
    );
  },
);

it("does not treat an unreviewed Hyper3D package as a migration target", async () => {
  expect(await model3DMigrationPackageIssue("/unused", "hyper3d")).toBe(
    "plugin-release-not-reviewed",
  );
});
