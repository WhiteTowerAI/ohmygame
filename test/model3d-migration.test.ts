import { ProjectManager } from "../src/daemon/projects.js";
import { CanvasStore } from "../src/daemon/canvas-workspace.js";
import type { Model3DOptions } from "../src/shared/contracts.js";

import { migrateModel3DSettings } from "../src/daemon/model3d-settings-migration.js";
import { killAt } from "./fixtures/settings-transaction-process.js";
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
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createApp } from "../src/daemon/app.js";
import { ToolRunner } from "../src/daemon/tools.js";
import { TEST_GLB } from "./model3d-fixture.js";
import {
  MODEL3D_MIGRATION_PACKAGES,
  checkModel3DMigrationPackage,
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
import { migratedMediaBoard, migratedMediaModel, type MediaMigrationState } from "../src/daemon/media-model-migration.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { createHash } from "node:crypto";
import { model3DTransactionFiles, model3DSettingsTransaction, proposeModel3DTransaction } from "../src/daemon/model3d-settings-transaction.js";
import { canvasReference, generateOnCanvas } from "./canvas-generation.js";

describe("prepared 3D model reference migration", () => {
  const state: MediaMigrationState = { model3D: [{ source: "meshy", target: "plugin.ohmygame.meshy.meshy", models: [{ id: "custom-version", operations: ["text", "image"] }], processing: { id: "connection", operations: ["remesh", "retexture", "animate"] } }] };
  it("maps a known custom generation selection without changing its settings", () => {
    const board = createCanvasBoard();
    board.nodes.push({ id: "model", type: "model-3d", position: { x: 10, y: 20 }, data: { model: { provider: "meshy", id: "custom-version" }, operation: "text", prompt: "Keep this direction", images: [], targetPolycount: 2000, texture: false, pbr: false } });
    const expected = structuredClone(board);
    (expected.nodes[0]!.data as { model: { provider: string } }).model.provider = "plugin.ohmygame.meshy.meshy";
    expect(migratedMediaBoard(board, state)).toEqual(expected);
    expect((board.nodes[0]!.data as { model: { provider: string } }).model.provider).toBe("meshy");
  });
  it.each(["image", "text", "remesh", "retexture", "animate"] as const)("maps only the selected %s capability and retains reference metadata", (operation) => {
    const board = createCanvasBoard();
    const model = { provider: "meshy", id: operation === "text" || operation === "image" ? "custom-version" : "old-geometry-version", label: "My choice" };
    board.nodes.push(operation === "animate"
      ? { id: "node", type: "animate-3d", position: { x: 0, y: 0 }, data: { model, heightMeters: 1.8, actionIds: [3, 1], options: { animateInPlace: true } } }
      : { id: "node", type: "model-3d", position: { x: 0, y: 0 }, data: { model, operation, images: [], targetPolycount: 2000, texture: false, pbr: false } });
    const expected = structuredClone(board);
    const node = expected.nodes[0]!;
    if (node.type !== "model-3d" && node.type !== "animate-3d") throw new Error("Expected 3D node");
    node.data.model = { ...model, provider: "plugin.ohmygame.meshy.meshy", id: ["image", "text"].includes(operation) ? model.id : "connection" };
    const migrated = migratedMediaBoard(board, state);
    expect(migrated).toEqual(expected);
    expect(migratedMediaBoard(migrated, state)).toBe(migrated);
    expect(migratedMediaBoard(board, {})).toBe(board);
    const unsupported: MediaMigrationState = { model3D: [{ ...state.model3D![0]!, models: [], processing: undefined }] };
    expect(migratedMediaBoard(board, unsupported)).toBe(board);
  });
  it("keeps unknown generation IDs, unrelated kinds and providers, and already mapped selections", () => {
    for (const ref of [{ provider: "meshy", id: "unknown" }, { provider: "cloud-hyper3d", id: "custom-version" }, { provider: "relay", id: "custom-version" }, { provider: "plugin.ohmygame.meshy.meshy", id: "custom-version" }])
      expect(migratedMediaModel(ref, "3d", state)).toBe(ref);
    const ref = { provider: "meshy", id: "custom-version", label: "Named" };
    expect(migratedMediaModel(ref, "image", state)).toBe(ref);
    expect(migratedMediaModel(ref, "video", state)).toBe(ref);
    expect(migratedMediaModel(ref, "3d", state)).toEqual({ ...ref, provider: "plugin.ohmygame.meshy.meshy" });
  });
  it("retains the implicit Meshy animation connection without changing implicit generation defaults", () => {
    const board = createCanvasBoard();
    board.nodes.push({ id: "animate", type: "animate-3d", position: { x: 0, y: 0 }, data: { actionIds: [0], heightMeters: 1.7 } });
    board.nodes.push({ id: "generate", type: "model-3d", position: { x: 0, y: 0 }, data: { images: [], targetPolycount: 4000, texture: true, pbr: false } });
    const migrated = migratedMediaBoard(board, state);
    expect(migrated.nodes[0]).toMatchObject({ data: { model: { provider: "plugin.ohmygame.meshy.meshy", id: "connection" } } });
    expect(migrated.nodes[1]).toBe(board.nodes[1]);
    expect(migratedMediaBoard(board, { model3D: [{ ...state.model3D![0]!, source: "tripo", target: "plugin.ohmygame.tripo.tripo" }] })).toBe(board);
  });
});

describe("Hyper3D enablement split", () => {
  it.each([[], ["hyper3d"], ["cloud-hyper3d"], ["hyper3d", "cloud-hyper3d"]].map((disabled) => ({ disabled })))("preserves both effective switches from $disabled", async ({ disabled }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "hyper3d-switches-"));
    try {
      await writeFile(path.join(directory, "hyper3d.json"), JSON.stringify({ version: 1, apiKey: "native-key" }));
      await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, disabled, future: true }));
      const before = await settingsSnapshot(directory, model3DSettingsFiles("hyper3d"));
      const models = MODEL_3D_PRESETS.hyper3d.map((model) => pluginModel3DDefinition("hyper3d", model));
      const plan = await proposeModel3DSettings(before, "hyper3d", models);
      expect(plan.report.blockers).toEqual([]);
      const after = new Map([...before, ...plan.changes]);
      const visibility = JSON.parse(after.get("model-visibility.json")!.toString());
      expect(visibility.disabled.includes("plugin.ohmygame.hyper3d.hyper3d")).toBe(disabled.length > 0);
      expect(visibility.disabled.includes("cloud-hyper3d")).toBe(disabled.length > 0);
      expect(visibility.future).toBe(true);
      expect((await proposeModel3DSettings(after, "hyper3d", models)).changes.size).toBe(0);
      expect(await settingsSnapshot(directory, model3DSettingsFiles("hyper3d"))).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe.each(MODEL3D_MIGRATION_PACKAGES)(
  "$provider reviewed Beta migration package",
  (pin) => {
    const host = { meshy: "assets.meshy.ai", tripo: "openapi-dl.data.tripo3d.com", hyper3d: "file.hyper3d.com" }[pin.provider];
    function rodinResponse(url: string, artifact: string, submit: () => string) {
      if (url.endsWith("/status")) return Response.json({ jobs: [{ status: "Done" }] });
      if (url.endsWith("/download")) return Response.json({ list: [{ name: "model.glb", url: artifact }] });
      if (url.endsWith("/rodin") || url.endsWith("/rodin_texture_only"))
        return Response.json({ uuid: submit(), jobs: { subscription_key: "status-key" } });
      throw new Error("Unexpected Rodin endpoint");
    }
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
            [`${pin.id}@${pin.version}`]: pin.type === "release" ? {
              type: "github", repository: "WhiteTowerAI/ohmygame-plugins", release: `${pin.provider}-v${pin.version}`,
            } : {
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
          (await checkModel3DMigrationPackage(directory, pin.provider)).manifest,
        ).toEqual(manifest);
        expect(await snapshot(directory)).toEqual(before);
        const prepared = JSON.parse(
          await readFile(".runtime/preinstalled-plugins/index.json", "utf8"),
        );
        expect(
          prepared.plugins.some((entry: { id: string }) => entry.id === pin.id),
        ).toBe(false);
      });
    });

    if (pin.provider === "meshy") {
      it("defers an installation indexed as 0.1.1 before changing any settings", async () => {
        await fixture(async (directory) => {
          const indexFile = path.join(directory, "plugin-store/index.json");
          const index = JSON.parse(await readFile(indexFile, "utf8"));
          index.entries[0].version = "0.1.1";
          await writeFile(indexFile, JSON.stringify(index));
          const before = await snapshot(directory);
          expect(await migrateModel3DSettings(directory, "meshy")).toEqual({
            status: "deferred", reasons: ["plugin-release-not-reviewed"],
          });
          expect(await snapshot(directory)).toEqual(before);
        });
      });
    }

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

    async function transactionPlan(directory: string, root: string) {
      const media = JSON.parse(await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8")).contributes.providers[0].media["3d"];
      const ownedFiles = model3DTransactionFiles(pin.provider);
      const before = await settingsSnapshot(directory, ownedFiles);
      const plan = await proposeModel3DTransaction(before, pin.provider, media);
      expect(plan.report.blockers).toEqual([]);
      const transaction = model3DSettingsTransaction(pin.provider);
      return { before, plan, transaction, media, ownedFiles };
    }

    it("retires native catalogs and settings from the committed application context", async () => {
      await fixture(async (directory, root) => {
        const { before, plan, transaction } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        await transaction.resumeSettingsTransaction(directory);
        await transaction.commitSettingsTransaction(directory);
        const record = (await transaction.committedMigration(directory))!;
        const projects = new ProjectManager(directory);
        await projects.load();
        const project = await projects.create("Saved 3D selections", "asset-canvas");
        const legacy = { provider: pin.provider, id: MODEL_3D_PRESETS[pin.provider][0]!.id };
        await projects.setMediaModelDefaults(project.id, { "3d": legacy });
        const oldTools = new ToolRunner(directory, { generate: vi.fn() });
        const oldCanvas = new CanvasStore(projects, oldTools);
        const boardId = (await oldCanvas.workspace(project.id)).boards[0]!.id;
        const board = await oldCanvas.board(project.id, boardId);
        board.board.nodes.push({ id: "future", type: "model-3d", position: { x: 0, y: 0 }, data: { model: legacy, operation: "text", prompt: "Future tower", images: [], targetPolycount: 4000, texture: true, pbr: false } });
        board.board.editorLayout.nodes.future = { x: 0, y: 0 };
        await oldCanvas.saveBoard(project.id, board.board, board.revision);
        await oldCanvas.close();
        const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
        const request = vi.fn<typeof fetch>(async () => { throw new Error("Unexpected provider request"); });
        const artifact = `https://${host}/model.glb`;
        let taskNumber = 0;
        const pluginRequest = vi.fn<typeof fetch>(async (url, init) => {
          if (String(url) === artifact) return new Response(new Uint8Array(TEST_GLB));
          if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: "source-file" } });
          if (pin.provider === "hyper3d") return rodinResponse(String(url), artifact, () => `plugin-${++taskNumber}`);
          const id = init?.method === "POST" ? `plugin-${++taskNumber}` : String(url).split("/").at(-1);
          if (pin.provider === "meshy") return init?.method === "POST" ? Response.json({ result: id }) : Response.json({ id, status: "SUCCEEDED", model_urls: { glb: artifact } });
          return init?.method === "POST" ? Response.json({ code: 0, data: { task_id: id } }) : Response.json({ code: 0, data: { task_id: id, status: "success", output: { model_url: artifact } } });
        });
        const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, model3DFetch: request, imageFetch: pluginRequest, model3DMigrations: [record] });
        try {
          await app.ready();
          expect(JSON.parse(await readFile(path.join(project.workspacePath, ".ohmygame/settings.json"), "utf8")).mediaModelDefaults["3d"]).toEqual({ ...legacy, provider: target });
          const mappedBoard = await app.inject(`/projects/${project.id}/canvas/boards/${boardId}`);
          expect(mappedBoard.statusCode).toBe(200);
          expect(mappedBoard.json().board.nodes.find((node: { id: string }) => node.id === "future").data.model).toEqual({ ...legacy, provider: target });
          const catalog = (await app.inject("/model3d-models/catalog")).json();
          expect(catalog.models.some((model: { provider: string }) => model.provider === target)).toBe(true);
          expect(catalog.models.some((model: { provider: string }) => model.provider === pin.provider)).toBe(false);
          const summaries = (await app.inject("/settings/providers")).json();
          expect(summaries.some((provider: { id: string }) => provider.id === pin.provider)).toBe(false);
          expect(summaries.some((provider: { id: string }) => provider.id === target)).toBe(true);
          const endpoint = `/settings/models/providers/${pin.provider}`;
          const definition = MODEL_3D_PRESETS[pin.provider][0]!;
          const beforeRequests = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
          const statuses = [];
          for (const [method, suffix, payload] of [
            ["GET", "", undefined], ["PUT", "", { apiKey: "replacement" }], ["DELETE", "", undefined],
            ["PATCH", "/enabled", { enabled: true }], ["GET", "/models", undefined],
            ["PUT", "/models/visibility", { ids: [definition.id], visible: false }],
            ["POST", "/models/custom", custom], ["PUT", `/models/${definition.id}`, definition],
            ["DELETE", `/models/${definition.id}/overrides`, undefined], ["DELETE", `/models/custom/${custom.id}`, undefined],
          ] as const) statuses.push((await app.inject({ method, url: endpoint + suffix, ...(payload ? { payload } : {}) })).statusCode);
          expect(statuses).toEqual(Array(10).fill(409));
          expect(await settingsSnapshot(directory, model3DTransactionFiles(pin.provider))).toEqual(beforeRequests);
          const first = await generateOnCanvas(app, "model-3d", { model: { provider: pin.provider, id: definition.id }, operation: "text", prompt: "A stone tower", images: [], texture: false, pbr: false });
          let completed = await first.finished();
          expect(completed, JSON.stringify(completed)).toMatchObject({ status: "succeeded", model: { provider: target, id: definition.id } });
          expect(taskNumber).toBe(1);
          const sourceAssetId = completed.assetId;
          expect(sourceAssetId).toBeTruthy();
          const options = ({ meshy: { textureModel: "meshy-6" }, tripo: { textureQuality: "detailed" }, hyper3d: {} } satisfies Record<string, Model3DOptions>)[pin.provider] as Model3DOptions;
          // Retextured on the same canvas, which has the model.
          completed = await (await generateOnCanvas(app, "model-3d", async (projectId) => ({ model: { provider: pin.provider, id: definition.id }, operation: "retexture" as const, source: { type: "library" as const, assetId: sourceAssetId! }, prompt: "Weathered stone", images: pin.provider === "hyper3d" ? [await canvasReference(app, projectId)] : [], options }), { projectId: first.projectId })).finished();
          expect(completed, JSON.stringify(completed)).toMatchObject({ status: "succeeded", model: { provider: target, id: "connection" } });
          const texturePost = pluginRequest.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith({ meshy: "/retexture", tripo: "/models/texture", hyper3d: "/rodin_texture_only" }[pin.provider]));
          if (pin.provider === "hyper3d") {
            const form = texturePost?.[1]?.body as FormData;
            expect(form.get("model")).toBeInstanceOf(Blob);
            expect(form.get("image")).toBeInstanceOf(Blob);
          } else expect(JSON.parse(String(texturePost?.[1]?.body))).toMatchObject(pin.provider === "meshy" ? { ai_model: "meshy-6", model_url: expect.stringContaining("data:") } : { texture_quality: "detailed", input: "source-file" });
          expect(taskNumber).toBe(2); expect(request).not.toHaveBeenCalled();
        } finally { await app.close(); }

      });
    });

    it("commits settings and recovery ownership without later reviving native settings", async () => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const source = await readFile(path.join(directory, `${pin.provider}.json`));
        const result = await migrateModel3DSettings(directory, pin.provider);
        expect(result.status).toBe("migrated");
        if (result.status !== "migrated") throw new Error("Expected committed migration");
        expect(result.migration.references).toMatchObject({ source: pin.provider, target });
        expect(result.migration.recovery.models.find(({ id }) => id === custom.id)?.settings).toEqual(custom.settings);
        expect(await readFile(path.join(directory, `${pin.provider}.json`))).toEqual(source);
        const expected = { ...result, status: "committed" };
        expect(await migrateModel3DSettings(directory, pin.provider)).toEqual(expected);
        await rm(root, { recursive: true });
        await rm(path.join(directory, `${pin.provider}.json`));
        await rm(path.join(directory, "plugin-store/configuration.json"));
        const before = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
        expect(await migrateModel3DSettings(directory, pin.provider, true)).toEqual(expected);
        expect(await settingsSnapshot(directory, model3DTransactionFiles(pin.provider))).toEqual(before);
      });
    });

    it.each(["safe-mode", "changed-package", "key-conflict", "unknown-settings"])("defers activation on %s without changing settings", async (failure) => {
      await fixture(async (directory, root) => {
        if (failure === "changed-package") await writeFile(path.join(root, "media/adapter.js"), "changed");
        if (failure === "key-conflict") await writeFile(path.join(directory, "plugin-store/configuration.json"), JSON.stringify({ version: 1, plugins: { [pin.id]: { apiKey: { type: "secret", value: "different" } } } }));
        if (failure === "unknown-settings") await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 99, future: true }));
        const before = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
        const result = await migrateModel3DSettings(directory, pin.provider, failure === "safe-mode");
        expect(result.status).toBe("deferred");
        expect(result.reasons).toContain(failure === "safe-mode" ? "plugin-safe-mode" : failure === "changed-package" ? "plugin-package-mismatch" : failure === "key-conflict" ? "key-conflict" : "model-preferences-unreadable");
        expect(await settingsSnapshot(directory, model3DTransactionFiles(pin.provider))).toEqual(before);
        expect(await model3DSettingsTransaction(pin.provider).hasCommittedSettingsTransaction(directory)).toBe(false);
        expect(JSON.stringify(result)).not.toContain("private-canary");
      });
    });

    it.each(["absent", "target-only"])("handles an original key already cleared (%s)", async (mode) => {
      await fixture(async (directory) => {
        await rm(path.join(directory, `${pin.provider}.json`));
        if (mode === "target-only") await writeFile(path.join(directory, "plugin-store/configuration.json"), JSON.stringify({ version: 1, plugins: { [pin.id]: { apiKey: { type: "secret", value: "plugin-key" } } } }));
        const before = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
        const result = await migrateModel3DSettings(directory, pin.provider);
        expect(result.status).toBe(mode === "absent" ? "unchanged" : "migrated");
        expect((await settingsSnapshot(directory, [`${pin.provider}.json`])).get(`${pin.provider}.json`)).toBeUndefined();
        if (mode === "absent") expect(await settingsSnapshot(directory, model3DTransactionFiles(pin.provider))).toEqual(before);
        else expect(JSON.parse(await readFile(path.join(directory, "plugin-store/configuration.json"), "utf8")).plugins[pin.id].apiKey.value).toBe("plugin-key");
      });
    });

    it("restores an interrupted attempt before refusing a changed package", async () => {
      await fixture(async (directory, root) => {
        const { before, plan, transaction, ownedFiles } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        await writeFile(path.join(directory, "plugin-store/configuration.json"), plan.changes.get("plugin-store/configuration.json")!);
        await writeFile(path.join(root, "media/adapter.js"), "changed after interruption");
        expect(await migrateModel3DSettings(directory, pin.provider)).toEqual({ status: "deferred", reasons: ["plugin-package-mismatch"] });
        expect(await settingsSnapshot(directory, ownedFiles)).toEqual(before);
        expect(await transaction.recoverInterruptedSettings(directory)).toBe(false);
      });
    });

    it("rolls back applied settings when current grants fail final validation", async () => {
      await fixture(async (directory) => {
        await seed(directory);
        const before = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
        await expect(promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "test/fixtures/media-settings-transaction-worker.cjs", directory, "activate", "revoke-grants", pin.provider])).rejects.toMatchObject({ stderr: expect.stringContaining("3D settings migration failed; original settings restored") });
        expect(await settingsSnapshot(directory, model3DTransactionFiles(pin.provider))).toEqual(before);
        expect(JSON.parse(await readFile(path.join(directory, "plugin-store/grants.json"), "utf8")).plugins[pin.id].allowed).toEqual([]);
        expect(await model3DSettingsTransaction(pin.provider).hasCommittedSettingsTransaction(directory)).toBe(false);
        expect(await model3DSettingsTransaction(pin.provider).recoverInterruptedSettings(directory)).toBe(false);
      });
    });

    it.each(["plugin-store/configuration.json", "applied", "committed"])("recovers activation killed at %s", async (stage) => {
      await fixture(async (directory) => {
        await seed(directory);
        const before = await settingsSnapshot(directory, model3DTransactionFiles(pin.provider));
        const backup = `.${pin.provider}-settings-committed-v1.json`;
        await killAt(directory, "activate", stage === "committed" ? backup : stage, pin.provider);
        const result = await migrateModel3DSettings(directory, pin.provider);
        expect(result.status).toBe(stage === "committed" ? "committed" : "migrated");
        const receipt = JSON.parse(await readFile(path.join(directory, backup), "utf8"));
        for (const [file, bytes] of before) expect(receipt.files[file].before).toBe(bytes?.toString("base64") ?? null);
        expect(await migrateModel3DSettings(directory, pin.provider)).toEqual({ ...result, status: "committed" });
      });
    });

    it("seals the exact custom/preset and processing identities independently of later settings or uninstall", async () => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const { before, plan, transaction, media, ownedFiles } = await transactionPlan(directory, root);
        const expected = { source: pin.provider, target, models: [...media.models.map(({ id, operations }: { id: string; operations: string[] }) => ({ id, operations })), { id: custom.id, operations: ["text", "image"] }], processing: { id: media.processing.id, operations: media.processing.operations } };
        expect(await transaction.committedReferences(directory)).toBeUndefined();
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        expect(await transaction.committedReferences(directory)).toBeUndefined();
        await transaction.resumeSettingsTransaction(directory);
        expect(await transaction.committedReferences(directory)).toBeUndefined();
        const after = await settingsSnapshot(directory, ownedFiles);
        expect((await proposeModel3DTransaction(after, pin.provider, media)).changes.size).toBe(0);
        const metadata = after.get(ownedFiles[4]!)!.toString();
        expect(metadata).not.toMatch(/private-canary|private-model-canary|other-private-canary/);
        expect(JSON.parse(metadata).release).toEqual({ id: pin.id, version: pin.version, digest: pin.digest });
        await transaction.commitSettingsTransaction(directory);
        expect(await transaction.committedReferences(directory)).toEqual(expected);
        const committed = await transaction.committedMigration(directory);
        expect(committed?.recovery.models.find(({ id }) => id === custom.id)?.settings).toEqual(custom.settings);
        const preset = MODEL_3D_PRESETS[pin.provider][0]!, originalSettings = preset.settings;
        try {
          preset.settings = { ...originalSettings, supportsPbr: !originalSettings.supportsPbr };
          expect(await transaction.committedMigration(directory)).toEqual(committed);
        } finally { preset.settings = originalSettings; }
        expect(await readFile(path.join(directory, files[0]))).toEqual(before.get(files[0]));
        // Users may change or clear keys, models and preferences, then uninstall the package.
        await rm(path.join(directory, "plugin-store"), { recursive: true });
        for (const file of ownedFiles.filter((file) => !file.startsWith("plugin-store/")))
          await rm(path.join(directory, file), { force: true });
        expect(await transaction.committedReferences(directory)).toEqual(expected);
        expect(await transaction.committedMigration(directory)).toEqual(committed);
        const mapping = (await transaction.committedReferences(directory))!;
        mapping.models[0]!.operations = [];
        expect(await transaction.committedReferences(directory)).toEqual(expected);
        expect(migratedMediaModel({ provider: pin.provider, id: custom.id }, "3d", { model3D: [mapping] })).toEqual({ provider: target, id: custom.id });
        await expect(transaction.prepareSettingsTransaction(directory, await settingsSnapshot(directory, ownedFiles), new Map())).rejects.toThrow("already exists");
      });
    });

    it.each([false, true])("restores settings and mapping together after an interrupted transaction (fully applied: %s)", async (fullyApplied) => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const { before, plan, transaction, ownedFiles } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        if (fullyApplied) await transaction.resumeSettingsTransaction(directory);
        else {
          // A crash can leave any prefix of writes, including the new sidecar, on disk.
          for (const file of [files[1], ownedFiles[4]!])
            await writeFile(path.join(directory, file), plan.changes.get(file)!);
        }
        expect(await transaction.committedReferences(directory)).toBeUndefined();
        expect(await transaction.recoverInterruptedSettings(directory)).toBe(true);
        expect(await settingsSnapshot(directory, ownedFiles)).toEqual(before);
        expect(await transaction.committedReferences(directory)).toBeUndefined();
        expect(await transaction.recoverInterruptedSettings(directory)).toBe(false);
      });
    });

    it.each(["version", "operation", "source", "duplicate", "extra", "conflict"])("refuses an existing %s mapping without proposing partial settings", async (failure) => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const { before, plan, media, ownedFiles } = await transactionPlan(directory, root);
        const file = ownedFiles[4]!;
        const record = JSON.parse(plan.changes.get(file)!.toString());
        if (failure === "version") record.version = 2;
        if (failure === "operation") record.models[0].operations = ["animate"];
        if (failure === "source") record.source = pin.provider === "hyper3d" ? "meshy" : "hyper3d";
        if (failure === "duplicate") record.models.push(record.models[0]);
        if (failure === "extra") record.future = "keep";
        if (failure === "conflict") {
          record.models[0].id = "another-version";
          record.recovery.models[0].id = "another-version";
        }
        await writeFile(path.join(directory, file), JSON.stringify(record));
        const original = await settingsSnapshot(directory, ownedFiles);
        const result = await proposeModel3DTransaction(original, pin.provider, media);
        expect(result.report.blockers).toEqual([failure === "conflict" ? "reference-mapping-conflict" : "reference-mapping-unreadable"]);
        expect(result.changes.size).toBe(0);
        expect(await settingsSnapshot(directory, ownedFiles)).toEqual(original);
        expect(original.get(files[0])).toEqual(before.get(files[0]));
      });
    });

    it.each(["checksum", "phase", "missing", "version", "unknown-field", "recovery"])("refuses a corrupt committed %s record rather than inferring native ownership", async (failure) => {
      await fixture(async (directory, root) => {
        await seed(directory);
        const { before, plan, transaction, ownedFiles } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        await transaction.resumeSettingsTransaction(directory);
        await transaction.commitSettingsTransaction(directory);
        const backup = path.join(directory, `.${pin.provider}-settings-committed-v1.json`);
        const journal = JSON.parse(await readFile(backup, "utf8"));
        const file = ownedFiles[4]!;
        if (failure === "phase") journal.phase = "rolled-back";
        if (failure === "missing") journal.files[file] = { before: null, after: null };
        if (failure === "version" || failure === "unknown-field" || failure === "recovery") {
          const metadata = JSON.parse(Buffer.from(journal.files[file].after, "base64").toString());
          if (failure === "version") metadata.version = 2;
          else if (failure === "recovery") metadata.recovery.models[0].settings.future = "preserve";
          else metadata.future = "preserve";
          journal.files[file].after = Buffer.from(JSON.stringify(metadata)).toString("base64");
        }
        const { checksum: _, ...payload } = journal;
        journal.checksum = failure === "checksum" ? "invalid" : createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        const bytes = JSON.stringify(journal);
        await writeFile(backup, bytes);
        await expect(transaction.committedReferences(directory)).rejects.toThrow(/checksum|Invalid committed/);
        expect(await readFile(backup, "utf8")).toBe(bytes);
      });
    });

    it("keeps identity-only committed records readable but refuses to invent native recovery settings", async () => {
      await fixture(async (directory, root) => {
        const { before, plan, transaction, ownedFiles } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        await transaction.resumeSettingsTransaction(directory);
        await transaction.commitSettingsTransaction(directory);
        const expected = await transaction.committedReferences(directory);
        const backup = path.join(directory, `.${pin.provider}-settings-committed-v1.json`);
        const journal = JSON.parse(await readFile(backup, "utf8"));
        const file = ownedFiles[4]!;
        const metadata = JSON.parse(Buffer.from(journal.files[file].after, "base64").toString());
        delete metadata.recovery;
        journal.files[file].after = Buffer.from(JSON.stringify(metadata)).toString("base64");
        const { checksum: _, ...payload } = journal;
        journal.checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        const bytes = JSON.stringify(journal); await writeFile(backup, bytes);
        expect(await transaction.committedReferences(directory)).toEqual(expected);
        await expect(transaction.committedMigration(directory)).rejects.toThrow("no original recovery settings");
        expect(await readFile(backup, "utf8")).toBe(bytes);
      });
    });

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
          providerPreferences: pin.provider === "hyper3d" ? 2 : 1,
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
        expect(prefs.disabled).toEqual([pin.provider, "unrelated", ...(pin.provider === "hyper3d" ? ["cloud-hyper3d"] : []), target]);
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
              value.plugins[pin.id].allowed = pin.provider === "meshy"
                ? value.plugins[pin.id].allowed.filter((grant: string) => grant !== "network:cdn.meshy.ai")
                : [];
            });
          if (failure === "source")
            await edit("origins.json", (value) => {
              value[`${pin.id}@${pin.version}`].type = "development";
            });
          const before = await snapshot(directory);
          expect(
            (await checkModel3DMigrationPackage(directory, pin.provider)).issue,
          ).toBe(expected);
          expect(await snapshot(directory)).toEqual(before);
        });
      },
    );
  },
);
