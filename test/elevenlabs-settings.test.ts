import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { inspectElevenLabsMigration } from "../scripts/inspect-elevenlabs-migration.js";

import { cp } from "node:fs/promises";
import {
  ELEVENLABS_MIGRATION_PACKAGES,
  elevenlabsMigrationPackageIssue,
} from "../src/daemon/elevenlabs-migration-package.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";
import { ELEVENLABS_MIGRATION_MAPPINGS } from "../src/daemon/elevenlabs-migration-settings.js";

const source = "elevenlabs",
  target = "plugin.ohmygame.elevenlabs.elevenlabs";
const secret = "private-elevenlabs-test-secret",
  configuration = "plugin-store/configuration.json";
const ref = (id: string) => ({ provider: source, id, unknown: secret });
const plugin = (key: unknown) => ({
  version: 1,
  plugins: { "ohmygame/elevenlabs": { apiKey: key } },
});

async function bytes(directory: string) {
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    const file = path.join(entry.parentPath, entry.name);
    entries[path.relative(directory, file)] = entry.isFile()
      ? (await readFile(file)).toString("base64")
      : "directory";
  }
  return entries;
}

async function fixture(
  files: Record<string, unknown>,
  check: (
    report: Awaited<ReturnType<typeof inspectElevenLabsMigration>>,
  ) => void,
) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "elevenlabs-inspection-"),
  );
  try {
    for (const [name, value] of Object.entries(files)) {
      const file = path.join(directory, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        typeof value === "string" ? value : JSON.stringify(value),
      );
    }
    const before = await bytes(directory);
    const report = await inspectElevenLabsMigration(directory);
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report).toMatchObject({
      scope: "settings-only",
      activation: "held",
    });
    check(report);
    expect(await bytes(directory)).toEqual(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("ElevenLabs read-only migration inspection", () => {
  it("reports the key, disabled provider, hidden transcription and three generation defaults without modifying files", async () => {
    await fixture(
      {
        "elevenlabs.json": { version: 1, apiKey: secret, future: { secret } },
        "model-visibility.json": {
          version: 1,
          hidden: { [source]: ["scribe_v2", "eleven_v4"] },
          disabled: [source],
          defaultSpeechModel: ref("eleven_flash_v2_5"),
          defaultSoundEffectModel: ref("eleven_text_to_sound_v2"),
          defaultMusicModel: ref("music_v1"),
        },
        "plugin-store/settings.json": { version: 99, unknown: secret },
        "media-tasks/old-audio.json": {
          input: { model: ref("eleven_v4"), voiceId: secret, speed: 20 },
        },
      },
      (report) => {
        expect(report.regions[0]).toMatchObject({
          source,
          target,
          key: "copy",
          visibility: {
            action: "copy",
            source: {
              enabled: false,
              hiddenModels: ["eleven_v4", "scribe_v2"],
            },
          },
        });
        expect(report.defaultAudioModels).toEqual({
          speech: { action: "map", source, target, model: "eleven_flash_v2_5" },
          "sound-effect": {
            action: "map",
            source,
            target,
            model: "eleven_text_to_sound_v2",
          },
          music: { action: "map", source, target, model: "music_v1" },
        });
        expect(report.blockers).toEqual([]);
        expect(report.remainingChecks).toContain(
          "plugin-installation-and-enablement",
        );
        expect(report.remainingChecks).toContain(
          "unfinished-jobs-and-recovery-journals",
        );
      },
    );
  });

  it("blocks conflicting credentials and existing target choices", async () => {
    await fixture(
      {
        "elevenlabs.json": { version: 1, apiKey: secret },
        [configuration]: plugin({ type: "secret", value: "different-key" }),
        "model-visibility.json": {
          version: 1,
          hidden: { [source]: ["eleven_v4"], [target]: ["scribe_v2"] },
        },
      },
      (report) =>
        expect(report.blockers).toEqual([
          "elevenlabs:key-conflict",
          "elevenlabs:visibility-review-target",
        ]),
    );
    await fixture(
      {
        "elevenlabs.json": { version: 1, apiKey: secret },
        [configuration]: plugin({ type: "secret", value: secret }),
      },
      (report) => expect(report.regions[0].key).toBe("same"),
    );
    await fixture(
      { [configuration]: plugin({ type: "secret", value: secret }) },
      (report) => expect(report.regions[0].key).toBe("target-only"),
    );
  });

  it("refuses unknown visibility and cross-kind or transcription generation defaults", async () => {
    for (const id of ["scribe_v2", "music_v1", secret]) {
      await fixture(
        {
          "model-visibility.json": {
            version: 1,
            hidden: { [source]: [secret] },
            defaultSpeechModel: ref(id),
          },
        },
        (report) => {
          expect(report.blockers).toContain(
            "elevenlabs:visibility-unsupported-models",
          );
          expect(report.blockers).toContain("default-speech-model-unsupported");
          expect(report.defaultAudioModels?.speech).toEqual({
            action: "unsupported-model",
          });
        },
      );
    }
  });

  it("refuses malformed or future stores and invalid occupied keys without leaking parser input", async () => {
    for (const file of [
      "elevenlabs.json",
      configuration,
      "model-visibility.json",
    ]) {
      for (const value of [
        `{"${secret}":broken`,
        { version: 99, plugins: {}, hidden: {} },
      ]) {
        await fixture({ [file]: value }, (report) =>
          expect(
            report.blockers.some((code) => code.endsWith("unreadable")),
          ).toBe(true),
        );
      }
    }
    for (const key of [
      { type: "text", value: secret },
      { type: "secret", value: "" },
      { type: "secret", value: "x".repeat(4097) },
    ]) {
      await fixture({ [configuration]: plugin(key) }, (report) =>
        expect(report.regions[0].key).toBe("invalid"),
      );
    }
  });

  it("leaves missing stores and unrelated defaults alone", async () => {
    await fixture({}, (report) => {
      expect(report.regions[0].key).toBe("absent");
      expect(
        Object.values(report.defaultAudioModels!).map((item) => item.action),
      ).toEqual(["absent", "absent", "absent"]);
      expect(report.blockers).toEqual([]);
    });
    await fixture(
      {
        "model-visibility.json": {
          version: 1,
          hidden: {},
          defaultSpeechModel: { provider: secret, id: secret },
          defaultMusicModel: { provider: target, id: "music_v1" },
        },
      },
      (report) => {
        expect(report.defaultAudioModels?.speech.action).toBe("unchanged");
        expect(report.defaultAudioModels?.music.action).toBe("unchanged");
        expect(report.blockers).toEqual([]);
      },
    );
  });
});

// Exercise the actual released archive; shared rejection coverage stays in
// the existing MiniMax/Seedance suites.
describe("reviewed ElevenLabs package", () => {
  const pin = ELEVENLABS_MIGRATION_PACKAGES[0];
  async function installed(
    check: (directory: string, root: string) => Promise<void>,
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "elevenlabs-package-"));
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
      if (!added.ok) throw new Error("Invalid ElevenLabs package");
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
  it("accepts reviewed installed bytes and all seven model identities without preinstalling or mutating the profile", async () => {
    await installed(async (directory, root) => {
      const before = await bytes(directory);
      expect(await elevenlabsMigrationPackageIssue(directory)).toBeUndefined();
      expect(await bytes(directory)).toEqual(before);
      const manifest = JSON.parse(
        await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8"),
      );
      expect(manifest.beta).toBe(true);
      expect(manifest.engines["ohmygame-api"]).toBe("^2.21.0");
      const provider = manifest.contributes.providers[0];
      expect(provider.id).toBe("elevenlabs");
      expect(provider.apiKey).toBe("apiKey");
      expect(manifest.configuration.apiKey.type).toBe("secret");
      expect(
        provider.media.audio.models.map(
          (model: { id: string; kinds: string[] }) => ({
            id: model.id,
            kinds: model.kinds,
          }),
        ),
      ).toEqual(ELEVENLABS_MIGRATION_MAPPINGS[0].audioModels);
      expect(
        provider.media.audio.models.find(
          (model: { id: string }) => model.id === "scribe_v2",
        ).transcribes,
      ).toBe(true);
      const prepared = JSON.parse(
        await readFile(".runtime/preinstalled-plugins/index.json", "utf8"),
      );
      expect(
        prepared.plugins.some((entry: { id: string }) => entry.id === pin.id),
      ).toBe(false);
    });
  });
  it("refuses changed adapter bytes without altering them or trusting the cached digest", async () => {
    await installed(async (directory, root) => {
      await writeFile(path.join(root, "media/adapter.js"), "changed adapter");
      const before = await bytes(directory);
      expect(await elevenlabsMigrationPackageIssue(directory)).toBe(
        "plugin-package-mismatch",
      );
      expect(await bytes(directory)).toEqual(before);
    });
  });
  it("preserves a user's disabled plugin choice instead of granting or enabling it for migration", async () => {
    await installed(async (directory) => {
      const file = path.join(directory, "plugin-store/grants.json");
      const grants = JSON.parse(await readFile(file, "utf8"));
      grants.plugins[pin.id].enabled = false;
      await writeFile(file, JSON.stringify(grants));
      const before = await bytes(directory);
      expect(await elevenlabsMigrationPackageIssue(directory)).toBe(
        "plugin-not-enabled",
      );
      expect(await bytes(directory)).toEqual(before);
    });
  });
});
