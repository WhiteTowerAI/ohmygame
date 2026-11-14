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
    "refuses native paid retry for %s before generation and leaves original history bytes intact",
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
          expect(() => tools.retryJob("old")).toThrow(DOUBAO_RETIRED_RETRY);
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
