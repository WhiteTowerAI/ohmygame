import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createApp } from "../src/daemon/app.js";
import { ELEVENLABS_MIGRATION_PACKAGES } from "../src/daemon/elevenlabs-migration-package.js";
import { migrateElevenLabsSettings } from "../src/daemon/elevenlabs-settings-migration.js";
import { PluginIndex } from "../src/daemon/plugin-index.js";
import { capabilityGrants } from "../src/daemon/project-plugins.js";
import { ELEVENLABS_RETIRED_PROVIDER } from "../src/shared/media-migration-errors.js";
import { mp3Fixture } from "./audio-fixtures.js";
import { generateOnCanvas } from "./canvas-generation.js";

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
      }
    });
  });

  it("notes a historical native task and leaves other jobs unchanged", async () => {
    await fixture(async () => {
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
      expect(mediaJobNotice(job, state)).toMatchObject({
        error: ELEVENLABS_RETIRED_RETRY,
        model: legacy,
      });
      expect(mediaJobNotice(job, {})).toBe(job);
      const done = { ...job, status: "succeeded" as const };
      expect(mediaJobNotice(done, state)).toBe(done);
      const plugin = {
        ...job,
        input: { ...selection, model: { ...legacy, provider: target } },
      };
      expect(mediaJobNotice(plugin, state)).toBe(plugin);
    });
  });
});

describe("prepared ElevenLabs application ownership", () => {
  const pin = ELEVENLABS_MIGRATION_PACKAGES[0];
  const nativeRef = { provider: "elevenlabs", id: "eleven_flash_v2_5" };
  async function install(directory: string) {
    const root = path.join(
      directory,
      "plugin-store/packages",
      pin.id,
      pin.version,
    );
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
    if (!added.ok) throw new Error("Invalid published ElevenLabs fixture");
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
    await writeFile(
      path.join(directory, "elevenlabs.json"),
      JSON.stringify({ version: 1, apiKey: "native-key-canary", future: true }),
    );
    await writeFile(
      path.join(directory, "model-visibility.json"),
      JSON.stringify({ version: 1, hidden: {}, defaultSpeechModel: nativeRef }),
    );
    expect(await migrateElevenLabsSettings(directory)).toEqual({
      status: "migrated",
      reasons: [],
    });
  }
  function runtime(directory: string) {
    return ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "catalog.json"),
      allowModelNetwork: false,
    });
  }

  it("keeps the native connection available when no committed context is supplied", async () => {
    await fixture(async (directory) => {
      const file = path.join(directory, "elevenlabs.json"),
        bytes = JSON.stringify({
          version: 1,
          apiKey: "native-key-canary",
          future: true,
        });
      await writeFile(file, bytes);
      const modelRuntime = await runtime(directory),
        request = vi.fn<typeof fetch>();
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: request,
      });
      try {
        await app.ready();
        expect(
          (await app.inject("/audio-models/catalog"))
            .json()
            .models.some(
              (model: { provider: string }) => model.provider === "elevenlabs",
            ),
        ).toBe(true);
        expect(
          (await app.inject("/settings/models/providers/elevenlabs")).json(),
        ).toEqual({ configured: true });
        expect(request).not.toHaveBeenCalled();
        expect(await readFile(file, "utf8")).toBe(bytes);
      } finally {
        await app.close();
      }
    });
  });

  it("uses the installed Beta for generation, voices and transcription while retiring native settings and paid retries", async () => {
    await fixture(async (directory) => {
      const library = new AssetLibrary(directory),
        projects = new ProjectManager(directory, library);
      await library.load();
      await projects.load();
      const project = await projects.create("Audio ownership", "asset-canvas");
      await projects.setMediaModelDefaults(project.id, { speech: nativeRef });
      const oldTools = new ToolRunner(directory, { generate: vi.fn() });
      const oldCanvas = new CanvasStore(projects, library, oldTools);
      const boardId = (await oldCanvas.workspace(project.id)).boards[0]!.id;
      const originalBoard = await oldCanvas.board(project.id, boardId);
      originalBoard.board.nodes.push({
        id: "voice",
        type: "audio",
        position: { x: 0, y: 0 },
        data: {
          prompt: "你好",
          model: nativeRef,
          voiceId: "voice-1",
          speed: 20,
        },
      });
      originalBoard.board.editorLayout.nodes.voice = { x: 0, y: 0 };
      await oldCanvas.saveBoard(
        project.id,
        originalBoard.board,
        originalBoard.revision,
      );
      await oldCanvas.close();
      await mkdir(path.join(directory, "tools"), { recursive: true });
      const oldJob = {
        id: "native-paid",
        recoveryId: "native-receipt",
        toolId: "generate-audio",
        title: "Old paid request",
        createdAt: new Date().toISOString(),
        status: "failed",
        error: "Connection lost",
        model: nativeRef,
        input: { prompt: "Hello", model: nativeRef, voiceId: "voice-1" },
        prepared: true,
        metadata: {},
      };
      const jobsFile = path.join(directory, "tools/jobs.json"),
        oldBytes = JSON.stringify([oldJob]);
      await writeFile(jobsFile, oldBytes);
      await install(directory);
      const nativeFile = path.join(directory, "elevenlabs.json"),
        nativeBytes = await readFile(nativeFile);
      const nativeRequest = vi.fn<typeof fetch>(async () => {
        throw new Error("Native ElevenLabs must not run");
      });
      const audio = mp3Fixture(44100);
      const pluginRequest = vi.fn<typeof fetch>(async (url, init) => {
        expect(new Headers(init?.headers).get("xi-api-key")).toBe(
          "native-key-canary",
        );
        if (String(url).includes("/v2/voices?"))
          return Response.json({
            voices: [{ voice_id: "voice-1", name: "Test voice" }],
            has_more: false,
          });
        if (String(url).endsWith("/speech-to-text")) {
          const body = init?.body as FormData;
          expect(body.get("model_id")).toBe("scribe_v2");
          expect(body.get("language_code")).toBe("zh");
          return Response.json({ text: "你好，世界。", language_code: "zh" });
        }
        expect(String(url)).toBe(
          "https://api.elevenlabs.io/v1/text-to-speech/voice-1?output_format=mp3_44100_128",
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model_id: nativeRef.id,
          text: "你好",
          voice_settings: { speed: 1.2 },
        });
        return new Response(new Uint8Array(audio), {
          headers: {
            "content-type": "audio/mpeg",
            "request-id": "paid-plugin-result",
          },
        });
      });
      const modelRuntime = await runtime(directory);
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: nativeRequest,
        imageFetch: pluginRequest,
        elevenlabsSettingsMigrated: true,
      });
      try {
        await app.ready();
        const catalog = (await app.inject("/audio-models/catalog")).json();
        expect(
          catalog.models.some(
            (model: { provider: string }) => model.provider === "elevenlabs",
          ),
        ).toBe(false);
        expect(
          catalog.models.filter(
            (model: { provider: string }) => model.provider === target,
          ),
        ).toHaveLength(7);
        const summaries = (await app.inject("/settings/providers")).json();
        expect(
          summaries.some((item: { id: string }) => item.id === "elevenlabs"),
        ).toBe(false);
        expect(
          summaries.some((item: { id: string }) => item.id === target),
        ).toBe(true);
        for (const [method, suffix, payload] of [
          ["GET", "", undefined],
          ["PUT", "", { apiKey: "replacement" }],
          ["DELETE", "/credential", undefined],
          ["PATCH", "/enabled", { enabled: true }],
          ["GET", "/models", undefined],
        ] as const) {
          const response = await app.inject({
            method,
            url: `/settings/models/providers/elevenlabs${suffix}`,
            ...(payload ? { payload } : {}),
          });
          expect(response.statusCode).toBe(409);
          expect(response.json()).toEqual({
            error: ELEVENLABS_RETIRED_PROVIDER,
          });
        }
        expect(await readFile(jobsFile, "utf8")).toBe(oldBytes);
        const board = (
          await app.inject(`/projects/${project.id}/canvas/boards/${boardId}`)
        ).json();
        expect(
          board.board.nodes.find((node: { id: string }) => node.id === "voice")
            .data,
        ).toMatchObject({
          model: { ...nativeRef, provider: target },
          voiceId: "voice-1",
          speed: 20,
        });
        expect(
          JSON.parse(
            await readFile(
              path.join(project.workspacePath, ".ohmygame/settings.json"),
              "utf8",
            ),
          ).mediaModelDefaults.speech,
        ).toEqual({ ...nativeRef, provider: target });
        const defaults = await app.inject({
          method: "PUT",
          url: "/audio-models/speech/default",
          payload: nativeRef,
        });
        expect(defaults.statusCode).toBe(204);
        expect(
          (await app.inject("/audio-models/catalog")).json().defaultModels
            .speech,
        ).toEqual({ ...nativeRef, provider: target });
        const voices = await app.inject(
          `/audio-providers/${encodeURIComponent(target)}/voices?search=Test`,
        );
        expect(voices.statusCode, voices.body).toBe(200);
        expect(voices.json().voices).toEqual([
          { id: "voice-1", name: "Test voice" },
        ]);
        const completed = await (
          await generateOnCanvas(
            app,
            "audio",
            {
              model: nativeRef,
              prompt: "你好",
              voiceId: "voice-1",
              speed: 20,
              output: { format: "mp3", sampleRate: 44100 },
            },
            { projectId: project.id },
          )
        ).finished();
        expect(completed, JSON.stringify(completed)).toMatchObject({
          status: "succeeded",
          model: { ...nativeRef, provider: target },
        });
        const assetId = completed.assetId;
        expect(assetId).toBeTruthy();
        const transcript = await app.inject({
          method: "POST",
          url: `/projects/${project.id}/canvas/media`,
          payload: {
            operation: "transcribe-audio",
            assetIds: [assetId],
            options: { language: "zh-CN" },
          },
        });
        expect(transcript.statusCode, transcript.body).toBe(200);
        expect(transcript.json()).toEqual({
          kind: "text",
          text: "你好，世界。",
        });
        expect(pluginRequest).toHaveBeenCalledTimes(3);
        expect(nativeRequest).not.toHaveBeenCalled();
        expect(await readFile(nativeFile)).toEqual(nativeBytes);
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

  it("does not revive native access when a migrated plugin is disabled or retained native data is unreadable", async () => {
    await fixture(async (directory) => {
      await install(directory);
      const file = path.join(directory, "plugin-store/grants.json"),
        grants = JSON.parse(await readFile(file, "utf8"));
      grants.plugins[pin.id].enabled = false;
      await writeFile(file, JSON.stringify(grants));
      const nativeFile = path.join(directory, "elevenlabs.json");
      await writeFile(nativeFile, "retained unreadable native data");
      const request = vi.fn<typeof fetch>(async () => {
        throw new Error("No vendor call allowed");
      });
      const modelRuntime = await runtime(directory);
      const app = createApp({
        dataDirectory: directory,
        piAgentDirectory: directory,
        createModelRuntime: async () => modelRuntime,
        audioFetch: request,
        imageFetch: request,
        elevenlabsSettingsMigrated: true,
      });
      try {
        await app.ready();
        const catalog = (await app.inject("/audio-models/catalog")).json();
        expect(
          catalog.models.some(
            (model: { provider: string }) =>
              model.provider === target || model.provider === "elevenlabs",
          ),
        ).toBe(false);
        const result = await generateOnCanvas(app, "audio", {
          prompt: "Hello",
          model: nativeRef,
          voiceId: "voice-1",
        });
        // The canvas finds no audio model to run, so nothing starts.
        expect(result.response.statusCode).toBe(503);
        expect(request).not.toHaveBeenCalled();
        expect(await readFile(nativeFile, "utf8")).toBe(
          "retained unreadable native data",
        );
      } finally {
        await app.close();
      }
    });
  });
});
