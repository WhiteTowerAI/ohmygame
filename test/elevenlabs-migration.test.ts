import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import { ProjectManager } from "../src/daemon/projects.js";
import { ToolRunner } from "../src/daemon/tools.js";
import {
  migratedAudioSelection,
  migratedMediaBoard,
  migratedMediaModel,
  mediaJobNotice,
} from "../src/daemon/media-model-migration.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { ELEVENLABS_RETIRED_RETRY } from "../src/shared/media-migration-errors.js";
import type { AgentModelRef, RunToolRequest } from "../src/shared/contracts.js";
import type { AudioKind } from "../src/shared/audio.js";

const state = { elevenlabs: true };
const target = "plugin.ohmygame.elevenlabs.elevenlabs";
const legacy = {
  provider: "elevenlabs",
  id: "eleven_flash_v2_5",
  label: "My voice model",
};
const selection = {
  prompt: "你好",
  model: legacy,
  voiceId: "my-voice",
  language: "zh",
  speed: 20,
  assetId: "previous-audio",
  future: { retain: true },
};
async function fixture(check: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "elevenlabs-references-"),
  );
  try {
    await check(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("prepared ElevenLabs references", () => {
  it("maps reviewed generation kinds and preserves metadata without mapping Scribe or unrelated identities", () => {
    for (const [id, kind] of [
      ["eleven_v4", "speech"],
      ["eleven_flash_v2_5", "speech"],
      ["eleven_text_to_sound_v3", "sound-effect"],
      ["eleven_text_to_sound_v2", "sound-effect"],
      ["music_v2_5", "music"],
      ["music_v1", "music"],
    ] as const) {
      const model = { ...legacy, id };
      expect(migratedMediaModel(model, kind, state)).toEqual({
        ...model,
        provider: target,
      });
      expect(migratedMediaModel(model, "audio", state)).toEqual({
        ...model,
        provider: target,
      });
      expect(migratedMediaModel(model, "image", state)).toBe(model);
      expect(migratedMediaModel(model, "video", state)).toBe(model);
      expect(migratedMediaModel(model, kind, {})).toBe(model);
      for (const wrongKind of ["speech", "sound-effect", "music"] as const)
        if (kind !== wrongKind)
          expect(migratedMediaModel(model, wrongKind, state)).toBe(model);
    }
    for (const model of [
      { ...legacy, id: "scribe_v2" },
      { ...legacy, id: "future-model" },
      { ...legacy, provider: "doubao-speech" },
      { ...legacy, provider: target },
    ])
      expect(migratedMediaModel(model, "audio", state)).toBe(model);
    for (const model of [
      undefined,
      null,
      false,
      [],
      {},
      { provider: 1, id: "eleven_v4" },
    ])
      expect(
        migratedAudioSelection(
          model as AgentModelRef | undefined,
          undefined,
          state,
        ),
      ).toBe(model);
    expect(
      migratedAudioSelection(legacy, "future-kind" as AudioKind, state),
    ).toBe(legacy);
  });

  it("changes only future audio selections and remains idempotent", () => {
    const board = createCanvasBoard();
    board.nodes.push({
      id: "audio",
      type: "audio",
      position: { x: 10, y: 20 },
      data: selection,
    });
    const expected = structuredClone(board);
    (expected.nodes[0]!.data as typeof selection).model.provider = target;
    const next = migratedMediaBoard(board, state);
    expect(next).toEqual(expected);
    expect(migratedMediaBoard(next, state)).toBe(next);
    expect(migratedMediaBoard(board, {})).toBe(board);
    expect(selection.model.provider).toBe("elevenlabs");
  });

  it("maps pre-unification audio nodes without rewriting their raw fields", () => {
    const board = createCanvasBoard();
    const raw = board as unknown as { nodes: unknown[] };
    raw.nodes.push({
      id: "old-speech",
      type: "speech",
      position: { x: 0, y: 0 },
      data: {
        text: "Keep exact speech",
        model: legacy,
        voiceId: "saved-voice",
        subtitles: { language: "zh" },
      },
    });
    raw.nodes.push({
      id: "empty-legacy",
      type: "speech",
      position: { x: 0, y: 0 },
    });
    const expected = structuredClone(board) as unknown as {
      nodes: Array<{ data: { model: typeof legacy } }>;
    };
    expected.nodes[0]!.data.model.provider = target;
    expect(migratedMediaBoard(board, state)).toEqual(expected);
    expect(migratedMediaBoard(board, {})).toBe(board);
  });

  it("maps fresh input before catalog resolution but leaves prepared historical input with its owner", async () => {
    await fixture(async (directory) => {
      const resolved: RunToolRequest[] = [];
      const resolver = vi.fn(async (_id: string, input: RunToolRequest) => {
        resolved.push(input);
        return input;
      });
      const tools = new ToolRunner(
        directory,
        { generate: vi.fn() },
        undefined,
        undefined,
        undefined,
        resolver,
        undefined,
        state,
      );
      try {
        expect(await tools.prepare("generate-audio", selection)).toEqual({
          ...selection,
          model: { ...legacy, provider: target },
        });
        expect(resolved[0]).toEqual({
          ...selection,
          model: { ...legacy, provider: target },
        });
        expect(
          await tools.prepare("generate-audio", selection, undefined, {
            hooksApplied: true,
          }),
        ).toBe(selection);
        expect(resolved[1]).toBe(selection);
        for (const malformed of [null, false, []])
          expect(
            await tools.prepare(
              "generate-audio",
              malformed as unknown as RunToolRequest,
            ),
          ).toBe(malformed);
      } finally {
        await tools.close();
      }
    });
  });

  it("loads and saves project defaults and canvas selections while keeping options and refusing unknown board data", async () => {
    await fixture(async (directory) => {
      const library = new AssetLibrary(directory);
      const original = new ProjectManager(directory, library);
      await library.load();
      await original.load();
      const project = await original.create("Saved audio", "asset-canvas");
      const defaults = {
        speech: { provider: legacy.provider, id: legacy.id },
        "sound-effect": {
          provider: "elevenlabs",
          id: "eleven_text_to_sound_v3",
        },
        music: { provider: "elevenlabs", id: "music_v2_5" },
      };
      await original.setMediaModelDefaults(project.id, defaults);
      const tools = new ToolRunner(directory, { generate: vi.fn() });
      const before = new CanvasStore(original, library, tools);
      const boardId = (await before.workspace(project.id)).boards[0]!.id;
      const {
        future: _future,
        assetId: _assetId,
        ...knownSelection
      } = selection;
      const savedSelection = {
        ...knownSelection,
        model: { provider: legacy.provider, id: legacy.id },
      };
      const detail = await before.board(project.id, boardId);
      detail.board.nodes.push({
        id: "audio",
        type: "audio",
        position: { x: 10, y: 20 },
        data: savedSelection,
      });
      detail.board.editorLayout.nodes.audio = { x: 10, y: 20 };
      await before.saveBoard(project.id, detail.board, detail.revision);
      await before.close();
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
        expect(settings.mediaModelDefaults).toEqual(
          Object.fromEntries(
            Object.entries(defaults).map(([kind, ref]) => [
              kind,
              { ...ref, provider: target },
            ]),
          ),
        );
        const mapped = await canvas.board(project.id, boardId);
        expect(
          mapped.board.nodes.find((node) => node.id === "audio"),
        ).toMatchObject({
          data: {
            ...savedSelection,
            model: { provider: target, id: legacy.id },
          },
        });
        expect((await canvas.board(project.id, boardId)).revision).toBe(
          mapped.revision,
        );
        mapped.board.nodes.push({
          id: "another",
          type: "audio",
          position: { x: 0, y: 0 },
          data: {
            ...savedSelection,
            model: { provider: "elevenlabs", id: "music_v1" },
          },
        });
        mapped.board.editorLayout.nodes.another = { x: 0, y: 0 };
        await canvas.saveBoard(project.id, mapped.board, mapped.revision);
        expect(
          (await canvas.board(project.id, boardId)).board.nodes.find(
            (node) => node.id === "another",
          ),
        ).toMatchObject({
          data: { model: { provider: target, id: "music_v1" } },
        });
        const file = path.join(
          project.workspacePath,
          "canvas/boards",
          `${boardId}.json`,
        );
        const raw = JSON.parse(await readFile(file, "utf8"));
        raw.nodes[0].data.future = { retain: true };
        const bytes = JSON.stringify(raw);
        await writeFile(file, bytes);
        await expect(canvas.board(project.id, boardId)).rejects.toThrow();
        expect(await readFile(file, "utf8")).toBe(bytes);
      } finally {
        await canvas.close();
        await tools.close();
      }
    });
  });

  it("refuses historical retry before any generation and preserves the stored error and request bytes", async () => {
    await fixture(async (directory) => {
      const job = {
        id: "old",
        toolId: "generate-audio" as const,
        createdAt: new Date().toISOString(),
        title: "Paid audio",
        status: "failed" as const,
        error: "Connection lost",
        input: selection,
        model: legacy,
        recoveryId: "native-paid",
        prepared: true,
        metadata: {},
      };
      await mkdir(path.join(directory, "tools"));
      const file = path.join(directory, "tools/jobs.json");
      const bytes = JSON.stringify([job]);
      await writeFile(file, bytes);
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
        expect(tools.jobs()[0]).toMatchObject({
          error: ELEVENLABS_RETIRED_RETRY,
          model: legacy,
        });
        expect(() => tools.retryJob("old")).toThrow(ELEVENLABS_RETIRED_RETRY);
        expect(generate).not.toHaveBeenCalled();
        expect(mediaJobNotice(job, {})).toBe(job);
        const done = { ...job, status: "succeeded" as const };
        expect(mediaJobNotice(done, state)).toBe(done);
        const plugin = {
          ...job,
          input: { ...selection, model: { ...legacy, provider: target } },
        };
        expect(mediaJobNotice(plugin, state)).toBe(plugin);
      } finally {
        await tools.close();
      }
      expect(await readFile(file, "utf8")).toBe(bytes);
    });
  });
});
