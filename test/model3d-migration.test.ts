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
