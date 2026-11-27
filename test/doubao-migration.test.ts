import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createApp } from "../src/daemon/app.js";
import { DOUBAO_RETIRED_PROVIDER } from "../src/shared/media-migration-errors.js";
import { mp3Fixture } from "./audio-fixtures.js";
import { migrateDoubaoSettings } from "../src/daemon/doubao-settings-migration.js";
import {
  inspectDoubaoMigration,
  proposeDoubaoSettings,
} from "../src/daemon/doubao-migration-settings.js";
import { snapshot } from "../src/daemon/doubao-settings-snapshot.js";
import {
  prepareSettingsTransaction,
  resumeSettingsTransaction,
  hasCommittedSettingsTransaction,
  recoverInterruptedDoubaoSettings,
  SETTINGS_TRANSACTION_BACKUP,
} from "../src/daemon/doubao-settings-transaction.js";
import { migrateMediaSettingsAtStartup } from "../src/daemon/media-settings-startup.js";
import { MINIMAX_MIGRATION_PACKAGES } from "../src/daemon/minimax-migration-package.js";
import { killAt } from "./fixtures/settings-transaction-process.js";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DOUBAO_MIGRATION_PACKAGES,
  doubaoMigrationPackageIssue,
} from "../src/daemon/doubao-migration-package.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";

import { AssetLibrary } from "../src/daemon/asset-library.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import {
  migratedMediaModel,
  migratedMediaBoard,
  migratedAudioSelection,
  mediaJobNotice,
} from "../src/daemon/media-model-migration.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { migrateLegacyAudioNodes } from "../src/shared/audio-legacy.js";
import { DOUBAO_RETIRED_RETRY } from "../src/shared/media-migration-errors.js";
import type { RunToolRequest, AgentModelRef } from "../src/shared/contracts.js";
import type { AudioKind } from "../src/shared/audio.js";

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
          type: "github", repository: "WhiteTowerAI/ohmygame-plugins", release: `doubao-voice-v${pin.version}`,
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
      expect(manifest.engines["ohmygame-api"]).toBe("^2.38.0");
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
      const origin = (value: object) => writeFile(file, JSON.stringify({ [`${pin.id}@${pin.version}`]: value }));
      await origin({ type: "local", path: "/unrelated" });
      await unchangedIssue(directory, "plugin-source-not-reviewed");
      // The market's release of the same bytes from OhMyGame's repository is; a release elsewhere isn't.
      const release = { type: "github", commit: "a".repeat(40), release: `doubao-voice-v${pin.version}` };
      await origin({ ...release, repository: "WhiteTowerAI/ohmygame-plugins" });
      await unchangedIssue(directory);
      await origin({ ...release, repository: "acme/ohmygame-plugins" });
      await unchangedIssue(directory, "plugin-source-not-reviewed");
    });
  });
});

describe("prepared Doubao model references", () => {
  const state = { doubao: true };
  const target = "plugin.ohmygame.doubao-voice.doubao-voice";
  const legacy = { provider: "volcengine-tts", id: "seed-tts-2.0" };
  const selection = {
    model: legacy,
    prompt: "你好",
    voiceId: "saved-voice",
    voiceKind: "cloned" as const,
    voiceModel: "expressive" as const,
    speed: 20,
    output: { format: "mp3" as const, bitRate: 64000 },
  };
  async function fixture(check: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "doubao-references-"));
    try {
      await check(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  it("maps both current models and the historical Seed Audio identity only for compatible kinds in committed profiles", () => {
    for (const [provider, id, kinds] of [
      ["volcengine-tts", "seed-tts-2.0", ["speech"]],
      ["volcengine-tts", "seed-audio-1.0", ["speech", "sound-effect", "music"]],
      [
        "volcengine-seed-audio",
        "seed-audio-1.0",
        ["speech", "sound-effect", "music"],
      ],
    ] as const) {
      const model = { provider, id, future: { preserve: true } };
      for (const kind of [
        "speech",
        "sound-effect",
        "music",
        "audio",
        "image",
        "video",
        "3d",
      ] as const) {
        const mapped =
          kind === "audio" || kinds.some((value) => value === kind);
        expect(migratedMediaModel(model, kind, state)).toEqual(
          mapped ? { ...model, provider: target } : model,
        );
        expect(migratedMediaModel(model, kind, {})).toBe(model);
      }
    }
    for (const model of [
      { ...legacy, id: "future" },
      { ...legacy, provider: "other" },
      { ...legacy, provider: "volcengine-seed-audio" },
      { ...legacy, provider: target },
    ])
      expect(migratedMediaModel(model, "audio", state)).toBe(model);
    for (const value of [
      undefined,
      null,
      false,
      [],
      {},
      { provider: 1, id: "seed-tts-2.0" },
    ])
      expect(
        migratedAudioSelection(
          value as AgentModelRef | undefined,
          undefined,
          state,
        ),
      ).toBe(value);
    expect(migratedAudioSelection(legacy, "future" as AudioKind, state)).toBe(
      legacy,
    );
  });
  it.each([
    ["speech", "text", "Speak the following text exactly. "],
    [
      "sound-effect",
      "prompt",
      "Create a standalone game sound effect. Do not include speech, narration, singing, or background music. Description: ",
    ],
    [
      "music",
      "prompt",
      "Create instrumental game background music. Do not include vocals, speech, narration, or lyrics. Description: ",
    ],
  ])(
    "preserves the existing %s instruction and raw metadata when replacing the historical Seed Audio provider",
    (type, field, prefix) => {
      const board = createCanvasBoard();
      const node = {
        id: "old",
        type,
        position: { x: 2, y: 3 },
        data: {
          [field]: "A quiet forest",
          model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" },
          durationSeconds: 0.05,
          subtitles: { language: "zh" },
          future: { keep: true },
        },
      };
      (board as unknown as { nodes: unknown[] }).nodes.push(node);
      const before = structuredClone(board);
      const mapped = migratedMediaBoard(board, state);
      expect(mapped.nodes[0]).toEqual({
        ...node,
        data: {
          ...node.data,
          [field]: `${prefix}A quiet forest`,
          model: { ...node.data.model, provider: target },
        },
      });
      const current = migrateLegacyAudioNodes(mapped).value;
      expect((current.nodes[0]!.data as { prompt: string }).prompt).toBe(
        `${prefix}A quiet forest`,
      );
      const expected = migrateLegacyAudioNodes(board).value;
      (expected.nodes[0]!.data as { model: AgentModelRef }).model.provider =
        target;
      expect(current).toEqual(expected);
      expect(migratedMediaBoard(mapped, state)).toBe(mapped);
      expect(board).toEqual(before);
    },
  );
  it("maps fresh requests before resolution while preserving prepared historical requests", async () => {
    await fixture(async (directory) => {
      const resolve = vi.fn(
        async (_id: string, input: RunToolRequest) => input,
      );
      const tools = new ToolRunner(
        directory,
        { generate: vi.fn() },
        undefined,
        undefined,
        undefined,
        resolve,
        undefined,
        state,
      );
      try {
        expect(await tools.prepare("generate-audio", selection)).toEqual({
          ...selection,
          model: { ...legacy, provider: target },
        });
        expect(resolve.mock.calls[0]?.[1]).toMatchObject({
          model: { provider: target },
        });
        expect(
          await tools.prepare("generate-audio", selection, undefined, {
            hooksApplied: true,
          }),
        ).toBe(selection);
      } finally {
        await tools.close();
      }
    });
  });
  it("persists project defaults and old canvas choices on load, preserving intent and rejecting unknown data unchanged", async () => {
    await fixture(async (directory) => {
      const library = new AssetLibrary(directory);
      await library.load();
      const original = new ProjectManager(directory, library);
      await original.load();
      const project = await original.create(
        "Saved Doubao audio",
        "asset-canvas",
      );
      await original.setMediaModelDefaults(project.id, {
        speech: legacy,
        music: { provider: "volcengine-tts", id: "seed-audio-1.0" },
        "sound-effect": {
          provider: "volcengine-seed-audio",
          id: "seed-audio-1.0",
        },
      });
      const tools = new ToolRunner(directory, { generate: vi.fn() });
      const before = new CanvasStore(original, library, tools);
      const boardId = (await before.workspace(project.id)).boards[0]!.id;
      const detail = await before.board(project.id, boardId);
      await before.close();
      const file = path.join(
        project.workspacePath,
        "canvas/boards",
        `${boardId}.json`,
      );
      const raw = JSON.parse(await readFile(file, "utf8"));
      raw.nodes.push({
        id: "old",
        type: "music",
        data: {
          prompt: "Forest",
          model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" },
          durationSeconds: 2,
        },
      });
      await writeFile(file, JSON.stringify(raw));
      const projects = new ProjectManager(directory, library, undefined, state);
      await projects.load();
      const canvas = new CanvasStore(
        projects,
        library,
        tools,
        undefined,
        state,
      );
      try {
        const settings = JSON.parse(
          await readFile(
            path.join(project.workspacePath, ".ohmygame/settings.json"),
            "utf8",
          ),
        );
        expect(settings.mediaModelDefaults).toEqual({
          speech: { ...legacy, provider: target },
          music: { provider: target, id: "seed-audio-1.0" },
          "sound-effect": { provider: target, id: "seed-audio-1.0" },
        });
        const migrated = await canvas.board(project.id, boardId);
        expect(migrated.revision).not.toBe(detail.revision);
        expect(migrated.board.nodes[0]).toMatchObject({
          type: "audio",
          data: {
            model: { provider: target, id: "seed-audio-1.0" },
            prompt:
              "Create instrumental game background music. Do not include vocals, speech, narration, or lyrics. Description: Forest",
          },
        });
        expect((await canvas.board(project.id, boardId)).revision).toBe(
          migrated.revision,
        );
        const saved = JSON.parse(await readFile(file, "utf8"));
        expect(saved.nodes[0].type).toBe("music");
        saved.nodes[0].data.future = { keep: true };
        const unsupported = JSON.stringify(saved);
        await writeFile(file, unsupported);
        await expect(canvas.board(project.id, boardId)).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(unsupported);
      } finally {
        await canvas.close();
        await tools.close();
      }
    });
  });
  it.each(["volcengine-tts", "volcengine-seed-audio"])(
    "notes the retired native %s task without generation and leaves original history bytes intact",
    async (provider) => {
      await fixture(async (directory) => {
        const model = { provider, id: "seed-audio-1.0" };
        const job = {
          id: "old",
          toolId: "generate-audio" as const,
          createdAt: new Date().toISOString(),
          title: "Paid audio",
          status: "failed" as const,
          error: "Connection lost",
          input: { model, prompt: "Forest" },
          model,
          recoveryId: "native-paid",
          prepared: true,
          metadata: {},
        };
        await mkdir(path.join(directory, "tools"));
        const file = path.join(directory, "tools/jobs.json");
        const stored = JSON.stringify([job]);
        await writeFile(file, stored);
        const generate = vi.fn();
        const tools = new ToolRunner(
          directory,
          { generate },
          undefined,
          undefined,
          undefined,
          undefined,
          { generate, catalog: vi.fn() },
          state,
        );
        await tools.load();
        try {
          expect(tools.jobs()[0]?.error).toBe(DOUBAO_RETIRED_RETRY);
          expect(generate).not.toHaveBeenCalled();
          expect(mediaJobNotice(job, {})).toBe(job);
          const succeeded = { ...job, status: "succeeded" as const };
          expect(mediaJobNotice(succeeded, state)).toBe(succeeded);
          const plugin = {
            ...job,
            input: { ...job.input, model: { ...model, provider: target } },
          };
          expect(mediaJobNotice(plugin, state)).toBe(plugin);
        } finally {
          await tools.close();
        }
        expect(await readFile(file, "utf8")).toBe(stored);
      });
    },
  );
});

describe("prepared Doubao settings activation", () => {
  const secret = "doubao-migration-canary";
  const configuration = "plugin-store/configuration.json";
  const target = "plugin.ohmygame.doubao-voice.doubao-voice";
  const ref = (id: string) => ({ provider: "volcengine-tts", id });
  const plugin = (key: unknown) => ({
    version: 1,
    plugins: { [pin.id]: { apiKey: key } },
  });
  async function seedNative(directory: string, legacy = false) {
    if (legacy) {
      await writeFile(
        path.join(directory, "volcengine-tts.json"),
        JSON.stringify({
          version: 1,
          apiKey: secret,
          defaultVoiceId: "saved-voice",
        }),
      );
      await writeFile(
        path.join(directory, "volcengine-seed-audio.json"),
        JSON.stringify({ version: 1, apiKey: secret }),
      );
    } else
      await writeFile(
        path.join(directory, "doubao-voice.json"),
        JSON.stringify({
          version: 1,
          apiKey: secret,
          services: {},
          defaultVoiceId: "saved-voice",
        }),
      );
    await writeFile(
      path.join(directory, "model-visibility.json"),
      JSON.stringify({
        version: 1,
        hidden: { "volcengine-tts": ["seed-audio-1.0"] },
        disabled: ["volcengine-tts"],
        defaultSpeechModel: {
          ...ref("seed-tts-2.0"),
          voiceId: "custom-voice",
          speed: 20,
        },
        defaultSoundEffectModel: ref("seed-audio-1.0"),
        defaultMusicModel: ref("seed-audio-1.0"),
      }),
    );
  }
  async function nativeBytes(directory: string) {
    const all = await snapshot(directory);
    return (
      [
        "doubao-voice.json",
        "volcengine-tts.json",
        "volcengine-seed-audio.json",
      ] as const
    ).map((file) => all.get(file));
  }
  it.each([false, true])(
    "commits current or legacy-only settings once, preserving native data and later disconnection (legacy %s)",
    async (legacy) => {
      await installed(async (directory) => {
        await seedNative(directory, legacy);
        const original = await nativeBytes(directory);
        const grants = await readFile(
          path.join(directory, "plugin-store/grants.json"),
        );
        expect(await migrateDoubaoSettings(directory)).toEqual({
          status: "migrated",
          reasons: [],
        });
        const report = await inspectDoubaoMigration(directory);
        expect(report.blockers).toEqual([]);
        expect(
          proposeDoubaoSettings(await snapshot(directory), report).changes.size,
        ).toBe(0);
        const preferences = JSON.parse(
          await readFile(path.join(directory, "model-visibility.json"), "utf8"),
        );
        expect(preferences.defaultSpeechModel).toEqual({
          provider: target,
          id: "seed-tts-2.0",
          voiceId: "custom-voice",
          speed: 20,
        });
        expect(preferences.defaultSoundEffectModel).toEqual({
          provider: target,
          id: "seed-audio-1.0",
        });
        expect(preferences.defaultMusicModel).toEqual({
          provider: target,
          id: "seed-audio-1.0",
        });
        expect(preferences.hidden[target]).toEqual(["seed-audio-1.0"]);
        expect(preferences.disabled).toContain(target);
        expect(await nativeBytes(directory)).toEqual(original);
        expect(
          await readFile(path.join(directory, "plugin-store/grants.json")),
        ).toEqual(grants);
        const file = path.join(directory, configuration),
          config = JSON.parse(await readFile(file, "utf8"));
        expect(config.plugins[pin.id].apiKey.value).toBe(secret);
        expect(config.plugins[pin.id].defaultVoiceId).toEqual({
          type: "text",
          value: "saved-voice",
        });
        delete config.plugins[pin.id].apiKey;
        await writeFile(file, JSON.stringify(config));
        const before = await bytes(directory);
        expect(await migrateDoubaoSettings(directory)).toEqual({
          status: "committed",
          reasons: [],
        });
        expect(await bytes(directory)).toEqual(before);
      });
    },
  );
  it("leaves profiles with no native source unchanged", async () => {
    await installed(async (directory) => {
      const before = await bytes(directory);
      expect(await migrateDoubaoSettings(directory)).toEqual({
        status: "unchanged",
        reasons: [],
      });
      expect(await bytes(directory)).toEqual(before);
    });
  });
  it.each(["safe-mode", "conflict", "permissions", "unknown-native"])(
    "defers %s without mutating any profile file",
    async (failure) => {
      await installed(async (directory) => {
        await seedNative(directory);
        if (failure === "conflict")
          await writeFile(
            path.join(directory, configuration),
            JSON.stringify(plugin({ type: "secret", value: "different-key" })),
          );
        if (failure === "unknown-native") {
          const file = path.join(directory, "doubao-voice.json"),
            value = JSON.parse(await readFile(file, "utf8"));
          value.future = { retain: true };
          await writeFile(file, JSON.stringify(value));
        }
        if (failure === "permissions") {
          const file = path.join(directory, "plugin-store/grants.json"),
            value = JSON.parse(await readFile(file, "utf8"));
          value.plugins[pin.id].allowed = [];
          await writeFile(file, JSON.stringify(value));
        }
        const before = await bytes(directory);
        const result = await migrateDoubaoSettings(
          directory,
          failure === "safe-mode",
        );
        expect(result).toEqual({
          status: "deferred",
          reasons: [
            failure === "safe-mode"
              ? "plugin-safe-mode"
              : failure === "conflict"
                ? "key-conflict"
                : failure === "unknown-native"
                  ? "legacy-settings-unknown-fields"
                  : "plugin-permissions-missing",
          ],
        });
        expect(await bytes(directory)).toEqual(before);
      });
    },
  );

  it("recovers process death before and after the commit without changing native bytes", async () => {
    for (const boundary of [
      configuration,
      "applied",
      SETTINGS_TRANSACTION_BACKUP,
    ])
      await installed(async (directory) => {
        await seedNative(directory);
        const original = await nativeBytes(directory);
        await killAt(directory, "activate", boundary, "doubao");
        const result = await migrateDoubaoSettings(directory);
        expect(result.status).toBe(
          boundary === SETTINGS_TRANSACTION_BACKUP ? "committed" : "migrated",
        );
        expect(await hasCommittedSettingsTransaction(directory)).toBe(true);
        expect(await nativeBytes(directory)).toEqual(original);
        expect(
          JSON.parse(
            await readFile(path.join(directory, configuration), "utf8"),
          ).plugins[pin.id].apiKey.value,
        ).toBe(secret);
      });
  });

  it("rolls back owned settings when grants change before the final package check", async () => {
    await installed(async (directory) => {
      await seedNative(directory);
      const before = await snapshot(directory);
      await expect(
        killAt(directory, "activate", "revoke-grants", "doubao"),
      ).rejects.toThrow("original settings restored");
      expect(await snapshot(directory)).toEqual(before);
      expect(await hasCommittedSettingsTransaction(directory)).toBe(false);
      expect(await doubaoMigrationPackageIssue(directory)).toBe(
        "plugin-permissions-missing",
      );
    });
  });

  it.each([false, true])(
    "recovers Doubao before other shared settings writes, safe mode %s",
    async (safeMode) => {
      await installed(async (directory) => {
        await seedNative(directory);
        const minimax = MINIMAX_MIGRATION_PACKAGES.at(-1)!;
        const root = path.join(
          directory,
          "plugin-store/packages",
          minimax.id,
          minimax.version,
        );
        await cp(
          path.resolve(
            ".runtime/minimax-migration-packages",
            minimax.version,
            "source",
          ),
          root,
          { recursive: true },
        );
        const index = new PluginIndex(
          path.join(directory, "plugin-store/index.json"),
        );
        await index.load();
        const added = await index.add(root);
        if (!added.ok) throw new Error("Invalid MiniMax fixture");
        const originsFile = path.join(directory, "plugin-store/origins.json"),
          origins = JSON.parse(await readFile(originsFile, "utf8"));
        origins[`${minimax.id}@${minimax.version}`] = {
          type: "npm",
          package: minimax.package,
          version: minimax.version,
          registry: "npmjs",
        };
        await writeFile(originsFile, JSON.stringify(origins));
        const grantsFile = path.join(directory, "plugin-store/grants.json"),
          grants = JSON.parse(await readFile(grantsFile, "utf8"));
        grants.plugins[minimax.id] = {
          enabled: true,
          everyProject: true,
          allowed: capabilityGrants(added.entry.manifest),
        };
        await writeFile(grantsFile, JSON.stringify(grants));
        await writeFile(
          path.join(directory, "minimax.json"),
          JSON.stringify({ version: 1, globalApiKey: "minimax-canary" }),
        );
        const original = await snapshot(directory);
        const proposal = proposeDoubaoSettings(
          original,
          await inspectDoubaoMigration(directory),
        );
        await prepareSettingsTransaction(directory, original, proposal.changes);
        await resumeSettingsTransaction(directory);
        expect(
          JSON.parse(
            await readFile(path.join(directory, configuration), "utf8"),
          ).plugins[pin.id].apiKey.value,
        ).toBe(secret);
        const result = await migrateMediaSettingsAtStartup(directory, safeMode);
        expect(result.minimax.status).toBe(safeMode ? "deferred" : "migrated");
        expect(result.doubao.status).toBe(safeMode ? "deferred" : "migrated");
        expect(await hasCommittedSettingsTransaction(directory)).toBe(!safeMode);
        expect(await recoverInterruptedDoubaoSettings(directory)).toBe(false);
        if (safeMode) expect(await snapshot(directory)).toEqual(original);
        else {
          const config = JSON.parse(
            await readFile(path.join(directory, configuration), "utf8"),
          );
          expect(config.plugins[pin.id].apiKey.value).toBe(secret);
          expect(config.plugins[pin.id].defaultVoiceId.value).toBe("saved-voice");
          const preferences = JSON.parse(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
          expect(preferences.defaultSpeechModel).toMatchObject({ provider: target, voiceId: "custom-voice" });
          expect((await migrateMediaSettingsAtStartup(directory)).doubao.status).toBe("committed");
          expect(config.plugins[minimax.id].globalApiKey.value).toBe(
            "minimax-canary",
          );
        }
        expect((await snapshot(directory)).get("doubao-voice.json")).toEqual(
          original.get("doubao-voice.json"),
        );
      });
    },
  );
  it("stops startup before shared writes when a Doubao receipt is corrupt", async () => {
    await installed(async (directory) => {
      await seedNative(directory);
      const original = await snapshot(directory);
      await prepareSettingsTransaction(
        directory,
        original,
        proposeDoubaoSettings(original, await inspectDoubaoMigration(directory))
          .changes,
      );
      const receipt = path.join(directory, ".doubao-settings-transaction.json");
      const data = JSON.parse(await readFile(receipt, "utf8"));
      data.checksum = "invalid";
      await writeFile(receipt, JSON.stringify(data));
      const before = await bytes(directory);
      await expect(migrateMediaSettingsAtStartup(directory)).rejects.toThrow(
        "checksum",
      );
      expect(await bytes(directory)).toEqual(before);
    });
  });
});

describe("prepared Doubao application ownership", () => {
  const nativeRef = { provider: "volcengine-tts", id: "seed-tts-2.0" };
  const target = "plugin.ohmygame.doubao-voice.doubao-voice";
  const nativeSettings = {
    version: 1,
    apiKey: "native-key-canary",
    services: {},
    defaultVoiceId: "saved-voice",
  };
  function runtime(directory: string) {
    return ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "catalog.json"),
      allowModelNetwork: false,
    });
  }
  async function activate(directory: string) {
    await writeFile(
      path.join(directory, "doubao-voice.json"),
      JSON.stringify(nativeSettings),
    );
    await writeFile(
      path.join(directory, "model-visibility.json"),
      JSON.stringify({ version: 1, hidden: {}, defaultSpeechModel: nativeRef }),
    );
    expect(await migrateDoubaoSettings(directory)).toEqual({
      status: "migrated",
      reasons: [],
    });
  }
  it("keeps native behavior until the startup owner supplies a committed context", async () => {
    await installed(async (directory) => {
      const file = path.join(directory, "doubao-voice.json"),
        data = JSON.stringify(nativeSettings);
      await writeFile(file, data);
      const modelRuntime = await runtime(directory),
        request = vi.fn<typeof fetch>();
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: request,
        imageFetch: request,
      });
      try {
        await app.ready();
        expect(
          (await app.inject("/audio-models/catalog"))
            .json()
            .models.filter(
              (model: { provider: string }) =>
                model.provider === nativeRef.provider,
            ),
        ).toHaveLength(2);
        expect(
          (
            await app.inject("/settings/models/providers/volcengine-tts")
          ).json(),
        ).toMatchObject({ configured: true, defaultVoiceId: "saved-voice" });
        expect(await readFile(file, "utf8")).toBe(data);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });
  it("uses the published Beta for both audio models and rejects native endpoints and paid retries", async () => {
    await installed(async (directory) => {
      await activate(directory);
      const nativeFile = path.join(directory, "doubao-voice.json"),
        original = await readFile(nativeFile);
      const jobsFile = path.join(directory, "tools/jobs.json");
      await mkdir(path.dirname(jobsFile), { recursive: true });
      const oldJob = {
        id: "native-paid",
        recoveryId: "native-receipt",
        toolId: "generate-audio",
        title: "Old paid request",
        createdAt: new Date().toISOString(),
        status: "failed",
        error: "Connection lost",
        model: nativeRef,
        input: { prompt: "Hello", model: nativeRef },
        prepared: true,
        metadata: {},
      };
      const oldBytes = JSON.stringify([oldJob]);
      await writeFile(jobsFile, oldBytes);
      const nativeRequest = vi.fn<typeof fetch>(async () => {
        throw new Error("Native Doubao must not run");
      });
      const pluginRequest = vi.fn<typeof fetch>(async (url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("native-key-canary");
        expect(headers.get("x-api-request-id")).toMatch(/^[a-f0-9-]{36}$/);
        const body = JSON.parse(String(init?.body));
        if (String(url).endsWith("/unidirectional")) {
          expect(headers.get("x-api-resource-id")).toBe("seed-tts-2.0");
          expect(body.req_params).toMatchObject({
            text: "你好",
            speaker: "saved-voice",
            audio_params: {
              format: "mp3",
              sample_rate: 24000,
              speech_rate: 20,
            },
          });
          expect(JSON.parse(body.req_params.additions).post_process).toEqual({
            pitch: 2,
          });
          return new Response(
            JSON.stringify({ code: 0, data: mp3Fixture().toString("base64") }) +
              "\n" +
              JSON.stringify({ code: 20000000, usage: { text_words: 2 } }) +
              "\n",
            {
              headers: {
                "content-type": "application/json",
                "x-tt-logid": "plugin-tts-result",
              },
            },
          );
        }
        expect(String(url)).toBe(
          "https://openspeech.bytedance.com/api/v3/tts/create",
        );
        expect(body).toMatchObject({
          model: "seed-audio-1.0",
          text_prompt: "Wind through trees",
          audio_config: { format: "mp3", sample_rate: 48000 },
        });
        expect(body).not.toHaveProperty("references");
        return Response.json({
          code: 20000000,
          audio: mp3Fixture(48000).toString("base64"),
          original_duration: 0.24,
        });
      });
      const modelRuntime = await runtime(directory);
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: nativeRequest,
        imageFetch: pluginRequest,
        doubaoSettingsMigrated: true,
      });
      try {
        await app.ready();
        const catalog = (await app.inject("/audio-models/catalog")).json();
        expect(
          catalog.models.filter(
            (model: { provider: string }) =>
              model.provider === nativeRef.provider,
          ),
        ).toEqual([]);
        expect(
          catalog.models.filter(
            (model: { provider: string }) => model.provider === target,
          ),
        ).toHaveLength(2);
        expect(catalog.defaultModels.speech).toEqual({
          ...nativeRef,
          provider: target,
        });
        const summaries = (await app.inject("/settings/providers")).json();
        expect(
          summaries.some(
            (item: { id: string }) => item.id === nativeRef.provider,
          ),
        ).toBe(false);
        expect(
          summaries.some((item: { id: string }) => item.id === target),
        ).toBe(true);
        for (const [method, suffix, payload] of [
          ["GET", "", undefined],
          ["PUT", "", { apiKey: "replacement", defaultVoiceId: "new-voice" }],
          ["POST", "/preview", { text: "Hello" }],
          ["DELETE", "/credential", undefined],
          ["PATCH", "/enabled", { enabled: true }],
          ["GET", "/models", undefined],
        ] as const) {
          const response = await app.inject({
            method,
            url: `/settings/models/providers/volcengine-tts${suffix}`,
            ...(payload ? { payload } : {}),
          });
          expect(response.statusCode, response.body).toBe(409);
          expect(response.json()).toEqual({ error: DOUBAO_RETIRED_PROVIDER });
        }
        const legacyRoute = await app.inject(
          "/settings/models/providers/volcengine-seed-audio/models",
        );
        expect(legacyRoute.statusCode, legacyRoute.body).toBe(409);
        const listed = (await app.inject("/tool-jobs")).json();
        expect(listed.find((job: { id: string }) => job.id === "native-paid")?.error).toBe(DOUBAO_RETIRED_RETRY);
        expect(await readFile(jobsFile, "utf8")).toBe(oldBytes);
        for (const payload of [
          {
            model: nativeRef,
            prompt: "你好",
            speed: 20,
            pitch: 2,
            output: { format: "mp3", sampleRate: 24000 },
          },
          {
            model: { provider: "volcengine-seed-audio", id: "seed-audio-1.0" },
            prompt: "Wind through trees",
            output: { format: "mp3", sampleRate: 48000 },
          },
        ]) {
          const started = await app.inject({
            method: "POST",
            url: "/tools/generate-audio/jobs",
            payload,
          });
          expect(started.statusCode, started.body).toBe(202);
          let completed: any;
          await expect
            .poll(
              async () => {
                completed = (await app.inject("/tool-jobs"))
                  .json()
                  .find((job: { id: string }) => job.id === started.json().id);
                return completed?.status;
              },
              { timeout: 10_000 },
            )
            .not.toBe("running");
          expect(completed, JSON.stringify(completed)).toMatchObject({
            status: "succeeded",
            model: { provider: target, id: payload.model.id },
          });
          expect(completed.run.files[0].assetId).toBeTruthy();
        }
        expect(pluginRequest).toHaveBeenCalledTimes(2);
        expect(nativeRequest).not.toHaveBeenCalled();
        expect(await readFile(nativeFile)).toEqual(original);
        expect(
          JSON.parse(await readFile(jobsFile, "utf8")).find(
            (job: { id: string }) => job.id === oldJob.id,
          ),
        ).toEqual(oldJob);
      } finally {
        await app.close();
      }
    });
  }, 20_000);
  it("does not revive native settings when the plugin is disabled and retained native files are unreadable", async () => {
    await installed(async (directory) => {
      await activate(directory);
      const file = path.join(directory, "plugin-store/grants.json"),
        grants = JSON.parse(await readFile(file, "utf8"));
      grants.plugins[pin.id].enabled = false;
      await writeFile(file, JSON.stringify(grants));
      for (const source of [
        "doubao-voice.json",
        "volcengine-tts.json",
        "volcengine-seed-audio.json",
      ])
        await writeFile(
          path.join(directory, source),
          "retained unreadable data",
        );
      const original = await snapshot(directory),
        modelRuntime = await runtime(directory);
      const request = vi.fn<typeof fetch>(async () => {
        throw new Error("No vendor calls allowed");
      });
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: request,
        imageFetch: request,
        doubaoSettingsMigrated: true,
      });
      try {
        await app.ready();
        expect(
          (await app.inject("/audio-models/catalog"))
            .json()
            .models.some(
              (model: { provider: string }) =>
                model.provider === target ||
                model.provider === nativeRef.provider,
            ),
        ).toBe(false);
        const result = await app.inject({
          method: "POST",
          url: "/tools/generate-audio/jobs",
          payload: { model: nativeRef, prompt: "Hello" },
        });
        if (result.statusCode === 202)
          await expect
            .poll(
              async () =>
                (await app.inject("/tool-jobs"))
                  .json()
                  .find((job: { id: string }) => job.id === result.json().id)
                  ?.status,
              { timeout: 10_000 },
            )
            .toBe("failed");
        else expect(result.statusCode).toBe(400);
        expect(request).not.toHaveBeenCalled();
        expect(await snapshot(directory)).toEqual(original);
      } finally {
        await app.close();
      }
    });
  });
});
