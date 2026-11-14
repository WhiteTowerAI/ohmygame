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
import { MeshyProvider } from "../src/daemon/meshy-provider.js";
import { TripoProvider } from "../src/daemon/tripo-provider.js";
import { TEST_GLB } from "./model3d-fixture.js";
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
import { migratedMediaBoard, migratedMediaModel, type MediaMigrationState } from "../src/daemon/media-model-migration.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { createHash } from "node:crypto";
import { model3DTransactionFiles, model3DSettingsTransaction, proposeModel3DTransaction } from "../src/daemon/model3d-settings-transaction.js";

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

    async function transactionPlan(directory: string, root: string) {
      const media = JSON.parse(await readFile(path.join(root, ".ohmygame-plugin/plugin.json"), "utf8")).contributes.providers[0].media["3d"];
      const ownedFiles = model3DTransactionFiles(pin.provider);
      const before = await settingsSnapshot(directory, ownedFiles);
      const plan = await proposeModel3DTransaction(before, pin.provider, media);
      expect(plan.report.blockers).toEqual([]);
      const transaction = model3DSettingsTransaction(pin.provider);
      return { before, plan, transaction, media, ownedFiles };
    }

    it.each(["enabled", "cleared-key", "changed-key", "plugin-disabled", "provider-disabled", "missing-grants", "uninstalled", "unapproved-host", "insecure-url"])("uses current plugin authorization for an old native job (%s)", async (mode) => {
      await fixture(async (directory, root) => {
        let failDownload = true;
        const host = pin.provider === "meshy" ? "assets.meshy.ai" : "cdn.tripo3d.ai";
        const artifact = mode === "unapproved-host" ? "https://unapproved.test/model.glb" : `${mode === "insecure-url" ? "http" : "https"}://${host}/model.glb`;
        const request = vi.fn<typeof fetch>(async (url, init) => {
          if (String(url) === artifact) return failDownload ? new Response("offline", { status: 503 }) : new Response(new Uint8Array(TEST_GLB));
          if (pin.provider === "meshy") return init?.method === "POST" ? Response.json({ result: "owned-task" }) : Response.json({ status: "SUCCEEDED", model_urls: { glb: artifact } });
          if (String(url).endsWith("/files")) return Response.json({ code: 0, data: { file_token: "owned-file" } });
          return init?.method === "POST" ? Response.json({ code: 0, data: { task_id: "owned-task" } }) : Response.json({ code: 0, data: { status: "success", output: { model_url: artifact } } });
        });
        const Native = pin.provider === "meshy" ? MeshyProvider : TripoProvider;
        const original = new ToolRunner(directory, { generate: vi.fn() }, new Native(() => "private-canary", request, 0));
        await original.load();
        const job = original.start("image-to-3d", { model: { provider: pin.provider, id: MODEL_3D_PRESETS[pin.provider][0]!.id }, images: [{ mediaType: "image/png", data: "aW1hZ2U=" }] });
        await expect.poll(() => original.jobs()[0]?.status).toBe("failed"); await original.close();
        const { before, plan, transaction } = await transactionPlan(directory, root);
        await transaction.prepareSettingsTransaction(directory, before, plan.changes);
        await transaction.resumeSettingsTransaction(directory);
        await transaction.commitSettingsTransaction(directory);
        const record = (await transaction.committedMigration(directory))!;
        if (mode === "cleared-key" || mode === "changed-key") {
          const file = path.join(directory, "plugin-store/configuration.json"), stored = JSON.parse(await readFile(file, "utf8"));
          if (mode === "cleared-key") delete stored.plugins[pin.id].apiKey;
          else stored.plugins[pin.id].apiKey.value = "changed-plugin-key";
          await writeFile(file, JSON.stringify(stored));
        }
        if (mode === "plugin-disabled" || mode === "missing-grants") {
          const file = path.join(directory, "plugin-store/grants.json"), stored = JSON.parse(await readFile(file, "utf8"));
          if (mode === "plugin-disabled") stored.plugins[pin.id].enabled = false;
          else stored.plugins[pin.id].allowed = [];
          await writeFile(file, JSON.stringify(stored));
        }
        if (mode === "provider-disabled") await writeFile(path.join(directory, "model-visibility.json"), JSON.stringify({ version: 1, hidden: {}, disabled: [target] }));
        if (mode === "uninstalled") await rm(root, { recursive: true });
        const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: path.join(directory, "models.json"), modelsStorePath: path.join(directory, "catalog.json"), allowModelNetwork: false });
        const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime, model3DFetch: request, model3DRecovery: [record] });
        try {
          await app.ready(); failDownload = false; request.mockClear();
          expect((await app.inject({ method: "POST", url: `/tool-jobs/${job.id}/retry` })).statusCode).toBe(202);
          let current: { status: string; error?: string } | undefined;
          await expect.poll(async () => {
            current = (await app.inject("/tool-jobs")).json()[0]; return current?.status;
          }).toBe(mode === "enabled" ? "succeeded" : "failed");
          if (mode === "enabled") {
            expect(request.mock.calls.length).toBeGreaterThan(0);
            expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
            expect(request.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
          } else {
            if (mode === "unapproved-host" || mode === "insecure-url") {
              expect(request).toHaveBeenCalledTimes(1);
              expect(request.mock.calls.some(([url]) => String(url) === artifact)).toBe(false);
            } else expect(request).not.toHaveBeenCalled();
            expect(current?.error).toMatch(/plugin|connection or input changed|address/);
          }
          expect(JSON.parse(await readFile(path.join(directory, `${pin.provider}.json`), "utf8")).apiKey).toBe("private-canary");
        } finally { await app.close(); }
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
        if (failure === "source") record.source = "hyper3d";
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
