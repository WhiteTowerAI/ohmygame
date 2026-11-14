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
  DOUBAO_MIGRATION_PACKAGES,
  doubaoMigrationPackageIssue,
} from "../src/daemon/doubao-migration-package.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";

const pin = DOUBAO_MIGRATION_PACKAGES[0];
async function bytes(directory: string) {
  const files = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return Promise.all(
    files
      .filter((f) => f.isFile())
      .sort((a, b) =>
        path
          .join(a.parentPath, a.name)
          .localeCompare(path.join(b.parentPath, b.name)),
      )
      .map(async (f) => {
        const file = path.join(f.parentPath, f.name);
        return [
          path.relative(directory, file),
          (await readFile(file)).toString("base64"),
        ];
      }),
  );
}
async function installed(
  check: (directory: string, root: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "doubao-package-"));
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
    const added = await index.add(root);
    if (!added.ok) throw new Error("Invalid Doubao package");
    expect(added.entry.digest).toBe(pin.digest);
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
            allowed: capabilityGrants(added.entry.manifest),
          },
        },
        projects: {},
      }),
    );
    await check(directory, root);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function unchangedIssue(directory: string, expected?: string) {
  const before = await bytes(directory);
  expect(await doubaoMigrationPackageIssue(directory)).toBe(expected);
  expect(await bytes(directory)).toEqual(before);
}

describe("reviewed Doubao Beta package", () => {
  it("accepts actual published bytes and both model identities without preinstalling or changing the profile", async () => {
    await installed(async (directory, root) => {
      await unchangedIssue(directory);
      const manifest = JSON.parse(
        await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8"),
      );
      expect(manifest.beta).toBe(true);
      expect(manifest.engines["ohmygame-api"]).toBe("^2.25.0");
      expect(capabilityGrants(manifest)).toEqual([
        "network:openspeech.bytedance.com",
      ]);
      expect(manifest.configuration.apiKey.type).toBe("secret");
      expect(manifest.configuration.defaultVoiceId.type).toBe("text");
      const provider = manifest.contributes.providers[0];
      expect(provider.id).toBe("doubao-voice");
      expect(provider.apiKey).toBe("apiKey");
      expect(provider.media.audio.defaultVoiceSetting).toBe("defaultVoiceId");
      expect(
        provider.media.audio.models.map(
          (m: { id: string; kinds: string[] }) => ({
            id: m.id,
            kinds: m.kinds,
          }),
        ),
      ).toEqual([
        { id: "seed-tts-2.0", kinds: ["speech"] },
        { id: "seed-audio-1.0", kinds: ["speech", "sound-effect", "music"] },
      ]);
      const prepared = JSON.parse(
        await readFile(".runtime/preinstalled-plugins/index.json", "utf8"),
      );
      expect(
        prepared.plugins.some((entry: { id: string }) => entry.id === pin.id),
      ).toBe(false);
    });
  });
  it("rejects changed adapter bytes even when the cached digest is unchanged", async () => {
    await installed(async (directory, root) => {
      await writeFile(path.join(root, "media/adapter.js"), "changed adapter");
      await unchangedIssue(directory, "plugin-package-mismatch");
    });
  });
  it.each([
    [{ enabled: false }, "plugin-not-enabled"],
    [{ everyProject: false }, "plugin-not-enabled"],
    [{ allowed: [] }, "plugin-permissions-missing"],
  ])("preserves unavailable permission choices %j", async (choice, issue) => {
    await installed(async (directory) => {
      const file = path.join(directory, "plugin-store/grants.json");
      const grants = JSON.parse(await readFile(file, "utf8"));
      Object.assign(grants.plugins[pin.id], choice);
      await writeFile(file, JSON.stringify(grants));
      await unchangedIssue(directory, issue);
    });
  });
  it("rejects edited cached metadata beside unchanged published files", async () => {
    await installed(async (directory) => {
      const file = path.join(directory, "plugin-store/index.json");
      const index = JSON.parse(await readFile(file, "utf8"));
      index.entries[0].manifest.configuration.apiKey.type = "text";
      await writeFile(file, JSON.stringify(index));
      await unchangedIssue(directory, "plugin-index-mismatch");
    });
  });
  it("does not accept a local development origin as a reviewed managed release", async () => {
    await installed(async (directory) => {
      const file = path.join(directory, "plugin-store/origins.json");
      await writeFile(
        file,
        JSON.stringify({
          [`${pin.id}@${pin.version}`]: { type: "local", path: "/unrelated" },
        }),
      );
      await unchangedIssue(directory, "plugin-source-not-reviewed");
    });
  });
});
