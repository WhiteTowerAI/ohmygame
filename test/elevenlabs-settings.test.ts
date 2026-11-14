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
import { snapshot, same } from "../src/daemon/elevenlabs-settings-snapshot.js";
import { proposeElevenLabsSettings } from "../src/daemon/elevenlabs-migration-settings.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  rollbackSettingsTransaction,
  forgetSettingsTransaction,
  recoverInterruptedElevenLabsSettings,
  commitSettingsTransaction,
  hasCommittedSettingsTransaction,
  SETTINGS_TRANSACTION_BACKUP,
} from "../src/daemon/elevenlabs-settings-transaction.js";
import { rehearseElevenLabsMigration } from "../scripts/rehearse-elevenlabs-migration.js";
import { killAt } from "./fixtures/settings-transaction-process.js";
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

describe("ElevenLabs settings migration rehearsal", () => {
  const speech = {
    ...ref("eleven_flash_v2_5"),
    voiceId: "saved-voice",
    speed: 20,
  };
  async function staged(check: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(
      path.join(tmpdir(), "elevenlabs-rehearsal-"),
    );
    try {
      await mkdir(path.join(directory, "plugin-store"));
      await writeFile(
        path.join(directory, "elevenlabs.json"),
        JSON.stringify({ version: 1, apiKey: secret, future: { secret } }),
      );
      await writeFile(
        path.join(directory, configuration),
        JSON.stringify({
          version: 1,
          plugins: {
            "ohmygame/elevenlabs": {
              unrelated: { type: "text", value: secret },
            },
            "other/plugin": { key: { type: "secret", value: secret } },
          },
          future: secret,
        }),
      );
      await writeFile(
        path.join(directory, "model-visibility.json"),
        JSON.stringify({
          version: 1,
          hidden: { [source]: ["scribe_v2"], other: ["future-model"] },
          disabled: [source, "other"],
          defaultSpeechModel: speech,
          defaultSoundEffectModel: ref("eleven_text_to_sound_v3"),
          defaultMusicModel: ref("music_v2_5"),
          future: secret,
        }),
      );
      await writeFile(
        path.join(directory, "plugin-store/settings.json"),
        JSON.stringify({ version: 1, disabled: true, future: secret }),
      );
      await check(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async function plan(directory: string) {
    const original = await snapshot(directory),
      report = await inspectElevenLabsMigration(directory);
    expect(report.blockers).toEqual([]);
    const proposal = proposeElevenLabsSettings(original, report);
    expect(proposal.counts).toMatchObject({
      keys: 1,
      providerPreferences: 1,
      defaultSpeechModel: true,
      defaultSoundEffectModel: true,
      defaultMusicModel: true,
    });
    expect([...proposal.changes.keys()]).not.toContain("elevenlabs.json");
    return { original, ...proposal };
  }

  it("preserves unknown fields, saved audio options and switches, reloads idempotently and restores exact original bytes", async () => {
    await staged(async (directory) => {
      const allBefore = await bytes(directory),
        { original, changes } = await plan(directory);
      await prepareSettingsTransaction(directory, original, changes);
      expect(same(await snapshot(directory), original)).toBe(true);
      await resumeSettingsTransaction(directory);
      const preferences = JSON.parse(
        await readFile(path.join(directory, "model-visibility.json"), "utf8"),
      );
      expect(preferences.defaultSpeechModel).toEqual({
        ...speech,
        provider: target,
      });
      expect(preferences.defaultSoundEffectModel).toEqual({
        ...ref("eleven_text_to_sound_v3"),
        provider: target,
      });
      expect(preferences.defaultMusicModel).toEqual({
        ...ref("music_v2_5"),
        provider: target,
      });
      expect(preferences.hidden).toEqual({
        [source]: ["scribe_v2"],
        other: ["future-model"],
        [target]: ["scribe_v2"],
      });
      expect(preferences.disabled).toEqual([source, "other", target]);
      expect(preferences.future).toBe(secret);
      const stored = JSON.parse(
        await readFile(path.join(directory, configuration), "utf8"),
      );
      expect(stored.plugins["ohmygame/elevenlabs"]).toEqual({
        apiKey: { type: "secret", value: secret },
        unrelated: { type: "text", value: secret },
      });
      expect(stored.plugins["other/plugin"].key.value).toBe(secret);
      expect(stored.future).toBe(secret);
      expect(
        proposeElevenLabsSettings(
          await snapshot(directory),
          await inspectElevenLabsMigration(directory),
        ).changes.size,
      ).toBe(0);
      await rollbackSettingsTransaction(directory);
      await forgetSettingsTransaction(directory);
      expect(await bytes(directory)).toEqual(allBefore);
    });
  });

  it("runs on a disposable copy, reports only counts and never changes the supplied profile", async () => {
    await staged(async (directory) => {
      const before = await bytes(directory);
      const result = await rehearseElevenLabsMigration(directory);
      expect(result).toMatchObject({
        status: "passed",
        activation: "held",
        proposed: {
          keys: 1,
          defaultSpeechModel: true,
          defaultSoundEffectModel: true,
          defaultMusicModel: true,
        },
        checks: {
          reload: true,
          idempotent: true,
          rollback: true,
          sourceUnchanged: true,
          cleanup: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(await bytes(directory)).toEqual(before);
      await writeFile(
        path.join(directory, configuration),
        JSON.stringify(plugin({ type: "secret", value: "conflicting-key" })),
      );
      const conflicted = await bytes(directory),
        blocked = await rehearseElevenLabsMigration(directory);
      expect(blocked.status).toBe("blocked");
      expect(blocked.blockers).toContain("elevenlabs:key-conflict");
      expect(await bytes(directory)).toEqual(conflicted);
    });
  });

  it("recovers process termination at both writes and the applied receipt before committing independently", async () => {
    for (const boundary of [configuration, "model-visibility.json", "applied"])
      await staged(async (directory) => {
        const { original, changes } = await plan(directory);
        await prepareSettingsTransaction(directory, original, changes);
        await killAt(directory, "resume", boundary, "elevenlabs");
        expect(await recoverInterruptedElevenLabsSettings(directory)).toBe(
          true,
        );
        expect(await snapshot(directory)).toEqual(original);
        expect(await recoverInterruptedElevenLabsSettings(directory)).toBe(
          false,
        );
        await prepareSettingsTransaction(directory, original, changes);
        await resumeSettingsTransaction(directory);
        await commitSettingsTransaction(directory);
        expect(await hasCommittedSettingsTransaction(directory)).toBe(true);
        const receipt = JSON.parse(
          await readFile(
            path.join(directory, SETTINGS_TRANSACTION_BACKUP),
            "utf8",
          ),
        );
        expect(receipt.files["elevenlabs.json"].before).toBe(
          original.get("elevenlabs.json")!.toString("base64"),
        );
        expect(receipt.files["elevenlabs.json"].after).toBe(
          receipt.files["elevenlabs.json"].before,
        );
      });
  });

  it("refuses a changed credential guard instead of overwriting it", async () => {
    await staged(async (directory) => {
      const { original, changes } = await plan(directory);
      await prepareSettingsTransaction(directory, original, changes);
      await writeFile(
        path.join(directory, "elevenlabs.json"),
        JSON.stringify({ version: 1, apiKey: "new-key" }),
      );
      const before = await bytes(directory);
      await expect(resumeSettingsTransaction(directory)).rejects.toThrow();
      expect(await bytes(directory)).toEqual(before);
    });
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
