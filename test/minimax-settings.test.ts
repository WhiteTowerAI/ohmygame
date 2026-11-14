import { createHash } from "node:crypto";
import { cp, access, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsWrites } from "../src/daemon/settings-writes.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { PluginValues } from "../src/daemon/plugin-values.js";
import type { PluginIndexEntry } from "../src/daemon/plugin-index.js";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import { createCanvasBoard } from "../src/shared/canvas-workspace.js";
import { canvasNodeContent } from "../src/shared/canvas-node-layout.js";
import { rehearseMinimaxMigration } from "../scripts/rehearse-minimax-migration.js";
import { inspectMinimaxMigration } from "../scripts/inspect-minimax-migration.js";

import { snapshot as settingsSnapshot } from "../scripts/minimax-settings-snapshot.js";
import { prepareSettingsTransaction, resumeSettingsTransaction, rollbackSettingsTransaction, forgetSettingsTransaction, SETTINGS_TRANSACTION_FILE } from "../scripts/minimax-settings-transaction.js";

const rehearsalHooks = vi.hoisted(() => ({
  beforeRead: undefined as ((target: string) => void) | undefined,
  created: undefined as ((directory: string) => void) | undefined,
  beforeRename: undefined as ((target: string) => Promise<void>) | undefined,
  afterRename: undefined as ((target: string) => Promise<void>) | undefined,
  beforeRemove: undefined as ((target: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const patched = { ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      rehearsalHooks.beforeRead?.(String(args[0]));
      return original.readFile(...args);
    },
    mkdtemp: async (...args: Parameters<typeof original.mkdtemp>) => {
      const directory = await original.mkdtemp(...args);
      if (String(args[0]).includes("ohmygame-minimax-rehearsal-")) rehearsalHooks.created?.(String(directory));
      return directory;
    },
    rename: async (...args: Parameters<typeof original.rename>) => {
      await rehearsalHooks.beforeRename?.(String(args[1]));
      await original.rename(...args);
      await rehearsalHooks.afterRename?.(String(args[1]));
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      await rehearsalHooks.beforeRemove?.(String(args[0]));
      await original.rm(...args);
    },
  };
  return { ...patched, default: patched };
});
afterEach(() => { rehearsalHooks.beforeRead = undefined; rehearsalHooks.created = undefined; rehearsalHooks.beforeRename = undefined; rehearsalHooks.afterRename = undefined; rehearsalHooks.beforeRemove = undefined; });

describe("Minimax settings", () => {
  it("persists the domestic and international API keys independently", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-settings-"));
    const settings = new MinimaxSettingsStore(directory);
    await settings.load();

    expect(settings.get("minimax-video-cn")).toEqual({ configured: false });
    expect(settings.get("minimax-video-global")).toEqual({ configured: false });
    await settings.update("minimax-video-cn", "  cn-key  ");
    await settings.update("minimax-video-global", "global-key");

    expect(JSON.parse(await readFile(path.join(directory, "minimax.json"), "utf8"))).toEqual({
      version: 1,
      cnApiKey: "cn-key",
      globalApiKey: "global-key",
    });
    const restored = new MinimaxSettingsStore(directory);
    await restored.load();
    expect(restored.key("minimax-video-cn")).toBe("cn-key");
    expect(restored.key("minimax-video-global")).toBe("global-key");

    await restored.clear("minimax-video-cn");
    expect(restored.get("minimax-video-cn")).toEqual({ configured: false });
    expect(restored.key("minimax-video-global")).toBe("global-key");
    await restored.clear("minimax-video-global");
    await expect(access(path.join(directory, "minimax.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects empty keys and non-ASCII control characters", async () => {
    const settings = new MinimaxSettingsStore(await mkdtemp(path.join(tmpdir(), "ohmygame-minimax-invalid-")));
    await expect(settings.update("minimax-video-cn", "   ")).rejects.toThrow("printable ASCII");
    await expect(settings.update("minimax-video-global", "key\nvalue")).rejects.toThrow("printable ASCII");
  });
});

describe("MiniMax migration inspection", () => {
  const secret = "test-canary-never-print-this-key";
  const pluginFile = "plugin-store/configuration.json";
  const plugin = (fields: object) => ({ version: 1, plugins: { "ohmygame/minimax": fields } });
  const value = (key: string) => ({ type: "secret", value: key });

  async function snapshot(directory: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const item of await readdir(directory, { recursive: true, withFileTypes: true }))
      files[path.relative(directory, path.join(item.parentPath, item.name))] = item.isFile()
        ? await readFile(path.join(item.parentPath, item.name), "utf8") : item.isDirectory() ? "<directory>" : "<link>";
    return files;
  }

  async function fixture(files: Record<string, unknown>, check: (directory: string) => Promise<void>) {
    const directory = await mkdtemp(path.join(tmpdir(), "minimax-inspection-"));
    try {
      for (const [name, data] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
        await writeFile(path.join(directory, name), typeof data === "string" ? data : JSON.stringify(data));
      }
      const before = await snapshot(directory);
      await check(directory);
      expect(await snapshot(directory)).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  it("maps regions independently and retains disabled/hidden choices and the video default", async () => {
    await fixture({
      "minimax.json": { version: 1, cnApiKey: secret, globalApiKey: `${secret}-global`, future: { secret } },
      [pluginFile]: plugin({ globalApiKey: value(`${secret}-global`) }),
      "model-visibility.json": { version: 1, hidden: { "minimax-video-cn": ["MiniMax-H3-Max"] }, disabled: ["minimax-video-cn"], defaultVideoModel: { provider: "minimax-video-global", id: "MiniMax-H3", future: secret } },
      "media-tasks/unconfirmed.json": { secret, status: "unconfirmed" },
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory);
      expect(report.regions.map(({ source, target, key }) => ({ source, target, key }))).toEqual([
        { source: "minimax-video-cn", target: "plugin.ohmygame.minimax.cn", key: "copy" },
        { source: "minimax-video-global", target: "plugin.ohmygame.minimax.global", key: "same" },
      ]);
      expect(report.regions[0].visibility).toMatchObject({ action: "copy", source: { enabled: false, hiddenModels: ["MiniMax-H3-Max"] } });
      expect(report.defaultVideoModel).toEqual({ action: "map", source: "minimax-video-global", target: "plugin.ohmygame.minimax.global", model: "MiniMax-H3" });
      expect(report.blockers).toEqual([]);
      expect(report).toMatchObject({ activation: "held", scope: "settings-only" });
      expect(report.remainingChecks).toContain("unfinished-jobs-and-recovery-journals");
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("reports conflicting target keys and explicit target visibility without overwriting either", async () => {
    await fixture({
      "minimax.json": { version: 1, cnApiKey: secret },
      [pluginFile]: plugin({ cnApiKey: value("different"), globalApiKey: value(secret) }),
      "model-visibility.json": { version: 1, hidden: { "plugin.ohmygame.minimax.cn": ["MiniMax-H3"] } },
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory);
      expect(report.regions.map((region) => region.key)).toEqual(["conflict", "target-only"]);
      expect(report.blockers).toEqual(["minimax-video-cn:key-conflict", "minimax-video-cn:visibility-review-target"]);
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("recognizes equivalent explicitly saved visibility", async () => {
    await fixture({
      "model-visibility.json": { version: 1, hidden: { "minimax-video-cn": ["MiniMax-H3-Max", "MiniMax-H3"], "plugin.ohmygame.minimax.cn": ["MiniMax-H3", "MiniMax-H3-Max"] }, disabled: ["minimax-video-cn", "plugin.ohmygame.minimax.cn"] },
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory);
      expect(report.regions[0].visibility?.action).toBe("same");
      expect(report.blockers).toEqual([]);
    });
  });

  it("blocks incompatible key slots and legacy values that would not fit the plugin", async () => {
    for (const fields of [{ cnApiKey: { type: "text", value: secret } }, { cnApiKey: value("") }, { cnApiKey: value(" ") }, { cnApiKey: value("x".repeat(4097)) }]) {
      await fixture({ [pluginFile]: plugin(fields) }, async (directory) => {
        expect((await inspectMinimaxMigration(directory)).regions[0].key).toBe("invalid");
      });
    }
    for (const key of ["x".repeat(4097), " bad ", "has\nnewline", "非ASCII"]) {
      await fixture({ "minimax.json": { version: 1, cnApiKey: key } }, async (directory) => {
        expect((await inspectMinimaxMigration(directory)).regions[0].key).toBe("invalid");
      });
    }
  });

  it("fails closed on future or damaged stores and redacts parser input", async () => {
    for (const file of ["minimax.json", pluginFile, "model-visibility.json"]) {
      for (const data of [`{"${secret}": broken`, { version: 99, hidden: {}, plugins: {} }, { version: 1, cnApiKey: false, hidden: false, plugins: { damaged: { key: { type: "future", value: secret } } } }]) {
        await fixture({ [file]: data }, async (directory) => {
          const report = await inspectMinimaxMigration(directory);
          expect(report.blockers.some((blocker) => blocker.endsWith("unreadable"))).toBe(true);
          expect(JSON.stringify(report)).not.toContain(secret);
        });
      }
    }
  });

  it("flags unknown model references without echoing arbitrary saved data", async () => {
    await fixture({ "model-visibility.json": { version: 1, hidden: { "minimax-video-cn": [secret], "plugin.ohmygame.minimax.global": [secret] }, defaultVideoModel: { provider: "minimax-video-cn", id: secret } } }, async (directory) => {
      const report = await inspectMinimaxMigration(directory);
      expect(report.blockers).toEqual(["minimax-video-cn:visibility-unsupported-models", "minimax-video-global:visibility-unsupported-models", "default-video-model-unsupported"]);
      expect(report.regions[0].visibility?.source.unknownModels).toBe(1);
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("does not create missing stores or mistake a missing directory for an empty installation", async () => {
    await fixture({}, async (directory) => {
      const report = await inspectMinimaxMigration(directory);
      expect(report.regions.map((region) => region.key)).toEqual(["absent", "absent"]);
      expect(report.defaultVideoModel.action).toBe("absent");
      await expect(inspectMinimaxMigration(path.join(directory, "missing"))).rejects.toThrow("existing");
    });
  });


  const model = { provider: "minimax-video-cn", id: "MiniMax-H3" };
  const index = { version: 1, boards: [{ id: "board", name: secret }], documents: [] };
  function board(id = "board", provider = model.provider, modelId = model.id) {
    const { editorLayout: _layout, ...content } = { ...createCanvasBoard(), id };
    const node = createAssetGenerationNode("video", { x: 0, y: 0 });
    if (node.type !== "video") throw new Error("Expected video node");
    node.data.model = { provider, id: modelId };
    node.data.prompt = secret;
    return { ...content, nodes: [canvasNodeContent(node)] };
  }
  const job = (id: string, status = "running", provider = model.provider) => ({
    id, recoveryId: id, toolId: "generate-video", status, createdAt: "now", title: secret,
    context: { projectId: "project", boardId: "board", nodeId: "node" },
    model: { ...model, provider }, input: { model: { ...model, provider }, prompt: secret },
  });

  it("counts saved references and unfinished jobs without interrupting or claiming them", async () => {
    await fixture({
      "project/canvas/index.json": index,
      "project/canvas/boards/board.json": board(),
      "project/canvas/jobs.json": [job("running"), job("finished", "succeeded"), job("pending", "cancelled", "plugin.ohmygame.minimax.global")],
      "media-tasks/pending.json": { fingerprint: "a".repeat(64), task: { id: secret }, future: secret },
      "media-tasks/unconfirmed.json": { fingerprint: "b".repeat(64) },
      "media-tasks/ready.json": { fingerprint: "c".repeat(64), outputs: [{ url: secret }] },
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory, [path.join(directory, "project")]);
      expect(report).toMatchObject({ version: 2, scope: "selected-workspaces", activation: "held" });
      const workspace = report.canvas!.workspaces[0];
      expect(workspace.boards).toMatchObject({ registered: 1, inspected: 1, unreadable: 0 });
      expect(workspace.providers[0]).toMatchObject({ boardReferences: 1, jobs: { running: 1, succeeded: 1 } });
      expect(workspace.jobs).toMatchObject({ total: 3, video: 3, missingJournal: 1 });
      expect(workspace.blockers).toEqual(["unfinished-minimax-jobs"]);
      expect(report.canvas!.journals).toMatchObject({ total: 3, unconfirmed: 1, taskRecorded: 1, resultRecorded: 1, linkedByRecoveryId: 1, unattributed: 2 });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain("a".repeat(64));
    });
  });

  it("flags unindexed, missing, future and unknown-model boards without losing their bytes", async () => {
    await fixture({
      "project/canvas/index.json": { ...index, boards: [...index.boards, { id: "missing", name: "Missing" }] },
      "project/canvas/boards/board.json": board("board", model.provider, secret),
      "project/canvas/boards/orphan.json": board("orphan"),
      "project/canvas/boards/future.json": { ...board("future"), version: 99 },
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory, [path.join(directory, "project")]);
      expect(report.canvas!.workspaces[0].boards).toEqual({ registered: 2, found: 3, inspected: 2, missing: 1, unindexed: 2, unreadable: 1 });
      expect(report.canvas!.workspaces[0].blockers).toEqual(expect.arrayContaining(["registered-boards-missing", "unindexed-boards", "boards-unreadable", "unsupported-board-models"]));
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("reports opaque, damaged and shared recovery records without guessing provider ownership", async () => {
    await fixture({
      "project/canvas/jobs.json": [job("repeat", "failed"), { ...job("repeat", "cancelled"), id: "retry" }, { ...job("mismatch"), model: { ...model, provider: "another" } }, { ...job("bad"), input: { prompt: secret } }],
      "media-tasks/repeat.json": { fingerprint: "d".repeat(64), task: { id: secret } },
      "media-tasks/damaged.json": `{ "${secret}": broken`,
      "media-tasks/future.json": { version: 2, fingerprint: "e".repeat(64), task: {} },
      "media-tasks/both.json": { fingerprint: "f".repeat(64), task: {}, outputs: [] },
      "media-tasks/write.json.tmp": secret,
    }, async (directory) => {
      const report = await inspectMinimaxMigration(directory, [path.join(directory, "project")]);
      expect(report.canvas!.journals).toMatchObject({ total: 4, unreadable: 3, ambiguous: 1, temporary: 1 });
      expect(report.blockers).toEqual(expect.arrayContaining(["shared-recovery-ids-require-review", "media-journals-require-ownership-review", "workspace-1:video-job-model-disagreement", "workspace-1:video-job-input-unreadable"]));
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("fails closed on malformed histories and indexes and does not create missing canvas files", async () => {
    for (const files of [
      { "project/canvas/index.json": { ...index, version: 2 } },
      { "project/canvas/jobs.json": { version: 2, jobs: [job("future")] } },
      { "project/canvas/jobs.json": [{ ...job("bad"), context: { boardId: "board", nodeId: "node" } }] },
      { "project/canvas/jobs.json": [{ ...job("future", "succeeded"), toolId: "future-video" }] },
    ]) await fixture(files, async (directory) => {
      const report = await inspectMinimaxMigration(directory, [path.join(directory, "project")]);
      expect(report.canvas!.workspaces[0].blockers).not.toEqual([]);
    });
    await fixture({ "empty/keep.txt": secret }, async (directory) => {
      const workspace = path.join(directory, "empty");
      const report = await inspectMinimaxMigration(directory, [workspace, workspace, path.join(directory, "absent")]);
      expect(report.canvas!.workspaces[0].blockers).toEqual([]);
      expect(report.blockers).toEqual(["workspace-2:duplicate-workspace", "workspace-3:workspace-unreadable"]);
    });
  });

  it.skipIf(process.platform === "win32")("rejects linked canvas and journal files without following them", async () => {
    await fixture({ "outside/secret.json": secret, "project/canvas/index.json": index, "project/canvas/boards/keep.txt": "", "media-tasks/keep.txt": "" }, async (directory) => {
      const outside = path.join(directory, "outside/secret.json");
      const links = ["project/canvas/boards/board.json", "media-tasks/linked.json"];
      for (const link of links) await symlink(outside, path.join(directory, link));
      try {
        const report = await inspectMinimaxMigration(directory, [path.join(directory, "project")]);
        expect(report.canvas!.workspaces[0].blockers).toContain("boards-unreadable");
        expect(report.canvas!.journals.unreadable).toBe(1);
        expect(JSON.stringify(report)).not.toContain(secret);
      } finally { for (const link of links) await rm(path.join(directory, link)); }
    });
  });

  it("rehearses key and preference migration, retains metadata and restores exact staged bytes", async () => {
    const settings = { version: 1, cnApiKey: secret, globalApiKey: "global-key", future: { keep: true } };
    const preferences = { version: 1, hidden: { "minimax-video-cn": ["MiniMax-H3-Max"], unrelated: ["custom"] }, disabled: ["unrelated", "minimax-video-cn"], defaultVideoModel: { provider: "minimax-video-cn", id: "MiniMax-H3", future: { keep: secret } }, future: ["keep"] };
    await fixture({ "minimax.json": settings, "model-visibility.json": preferences, [pluginFile]: { ...plugin({ globalApiKey: value("global-key"), extra: { type: "text", value: "keep", future: true } }), future: true } }, async (directory) => {
      let staged = "", copiedConfig: unknown, copiedPreferences: unknown, restored: Record<string, string> | undefined;
      rehearsalHooks.created = (location) => { staged = location; };
      rehearsalHooks.afterRename = async (target) => {
        if (!target.startsWith(staged + path.sep)) return;
        if (process.platform !== "win32") {
          expect((await lstat(staged)).mode & 0o777).toBe(0o700);
          expect((await lstat(target)).mode & 0o777).toBe(0o600);
        }
        const stored = JSON.parse(await readFile(target, "utf8"));
        if (target.endsWith("configuration.json") && stored.plugins["ohmygame/minimax"].cnApiKey) copiedConfig = stored;
        if (target.endsWith("model-visibility.json") && stored.defaultVideoModel.provider === "plugin.ohmygame.minimax.cn") copiedPreferences = stored;
      };
      rehearsalHooks.beforeRemove = async (target) => { if (target === staged) restored = await snapshot(staged); };
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "passed", activation: "held", proposed: { keys: 1, providerPreferences: 1, defaultVideoModel: true }, checks: { reload: true, idempotent: true, rollback: true, sourceUnchanged: true, cleanup: true } });
      expect(copiedConfig).toEqual({ ...plugin({ globalApiKey: value("global-key"), cnApiKey: value(secret), extra: { type: "text", value: "keep", future: true } }), future: true });
      expect(copiedPreferences).toEqual({ ...preferences, hidden: { ...preferences.hidden, "plugin.ohmygame.minimax.cn": ["MiniMax-H3-Max"] }, disabled: [...preferences.disabled, "plugin.ohmygame.minimax.cn"], defaultVideoModel: { ...preferences.defaultVideoModel, provider: "plugin.ohmygame.minimax.cn" } });
      expect(restored).toEqual(await snapshot(directory));
      expect(JSON.stringify(report)).not.toContain(secret);
      await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("blocks conflicts and future stores without applying a proposal", async () => {
    for (const files of [
      { "minimax.json": { version: 1, cnApiKey: secret }, [pluginFile]: plugin({ cnApiKey: value("independent-key") }) },
      { "minimax.json": { version: 2, cnApiKey: secret } },
    ]) await fixture(files, async (directory) => {
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "blocked", checks: { reload: null, rollback: null, sourceUnchanged: true, cleanup: true } });
      expect(report.blockers.length).toBeGreaterThan(0);
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  it("restores an absent target after a partial write failure and reports rollback failure honestly", async () => {
    for (const failRollback of [false, true]) await fixture({ "minimax.json": { version: 1, cnApiKey: secret }, "model-visibility.json": { version: 1, hidden: {}, defaultVideoModel: { provider: "minimax-video-cn", id: "MiniMax-H3" } } }, async (directory) => {
      let staged = "", preferenceWrites = 0, restored: Record<string, string> | undefined;
      rehearsalHooks.created = (location) => { staged = location; };
      rehearsalHooks.beforeRename = async (target) => {
        if (target.startsWith(staged + path.sep) && target.endsWith("model-visibility.json") && ++preferenceWrites === 2) throw new Error(secret);
      };
      rehearsalHooks.beforeRemove = async (target) => {
        if (target === path.join(staged, pluginFile) && failRollback) throw new Error(secret);
        if (target === staged) restored = await snapshot(staged);
      };
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "failed", checks: { rollback: !failRollback, sourceUnchanged: true, cleanup: true } });
      expect(report.blockers).toContain("apply-copy-failed");
      if (!failRollback) {
        // The staging directory may remain, but an originally absent target file must not.
        expect(restored?.[path.normalize(pluginFile)]).toBeUndefined();
        expect(restored?.["minimax.json"]).toBe(await readFile(path.join(directory, "minimax.json"), "utf8"));
        expect(restored?.["model-visibility.json"]).toBe(await readFile(path.join(directory, "model-visibility.json"), "utf8"));
      } else expect(report.blockers).toContain("rollback-copy-failed");
      expect(JSON.stringify(report)).not.toContain(secret);
      await expect(access(staged)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not overwrite unexpected staged edits during rollback", async () => {
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret } }, async (directory) => {
      let staged = "", preserved = false;
      rehearsalHooks.created = (location) => { staged = location; };
      rehearsalHooks.afterRename = async (target) => {
        if (target === path.join(staged, pluginFile)) await writeFile(target, JSON.stringify(plugin({ cnApiKey: value("intervening-key") })));
      };
      rehearsalHooks.beforeRemove = async (target) => {
        if (target === staged) preserved = (await readFile(path.join(staged, pluginFile), "utf8")).includes("intervening-key");
      };
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "failed", checks: { rollback: false, sourceUnchanged: true, cleanup: true } });
      expect(preserved).toBe(true);
    });
  });

  it("detects source changes without restoring over them", async () => {
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret } }, async (directory) => {
      const source = path.join(directory, "minimax.json"), before = await readFile(source, "utf8");
      rehearsalHooks.afterRename = async (target) => {
        if (target.endsWith("configuration.json")) await writeFile(source, JSON.stringify({ version: 1, cnApiKey: "user-changed-key" }));
      };
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "failed", checks: { rollback: true, sourceUnchanged: false, cleanup: true } });
      expect(report.blockers).toContain("source-settings-changed");
      expect(JSON.parse(await readFile(source, "utf8")).cnApiKey).toBe("user-changed-key");
      await writeFile(source, before);
    });
  });

  it("rehearses empty or already mapped settings without proposing changes", async () => {
    for (const files of [{}, { "minimax.json": { version: 1, cnApiKey: secret }, [pluginFile]: plugin({ cnApiKey: value(secret) }), "model-visibility.json": { version: 1, hidden: {}, defaultVideoModel: { provider: "plugin.ohmygame.minimax.cn", id: "MiniMax-H3" } } }]) await fixture(files, async (directory) => {
      const report = await rehearseMinimaxMigration(directory);
      expect(report).toMatchObject({ status: "passed", proposed: { keys: 0, providerPreferences: 0, defaultVideoModel: false }, checks: { idempotent: true, rollback: true, sourceUnchanged: true, cleanup: true } });
    });
  });

  it("reports cleanup failure instead of claiming that temporary secrets were removed", async () => {
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret } }, async (directory) => {
      let staged = "";
      rehearsalHooks.created = (location) => { staged = location; };
      rehearsalHooks.beforeRemove = async (target) => { if (target === staged) throw new Error(secret); };
      try {
        const report = await rehearseMinimaxMigration(directory);
        expect(report).toMatchObject({ status: "failed", checks: { rollback: true, sourceUnchanged: true, cleanup: false } });
        expect(report.blockers).toContain("temporary-cleanup-failed");
        expect(JSON.stringify(report)).not.toContain(secret);
        expect((await lstat(staged)).isDirectory()).toBe(true);
      } finally { rehearsalHooks.beforeRemove = undefined; await rm(staged, { recursive: true, force: true }); }
    });
  });

  it.skipIf(process.platform === "win32")("refuses linked source settings before making a temporary copy", async () => {
    await fixture({ "outside.json": { version: 1, cnApiKey: secret } }, async (directory) => {
      const link = path.join(directory, "minimax.json");
      let created = false;
      rehearsalHooks.created = () => { created = true; };
      await symlink(path.join(directory, "outside.json"), link);
      try {
        const report = await rehearseMinimaxMigration(directory);
        expect(report).toMatchObject({ status: "failed", blockers: ["read-source-failed"], checks: { cleanup: null } });
        expect(created).toBe(false);
        expect(JSON.stringify(report)).not.toContain(secret);
      } finally { await rm(link); }
    });
  });

  async function transaction(check: (directory: string, before: Awaited<ReturnType<typeof settingsSnapshot>>, changes: Awaited<ReturnType<typeof settingsSnapshot>>) => Promise<void>) {
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret }, "model-visibility.json": { version: 1, hidden: {}, future: ["retain"] } }, async (source) => {
      const directory = await mkdtemp(path.join(tmpdir(), "minimax-transaction-"));
      try {
        await cp(source, directory, { recursive: true });
        const before = await settingsSnapshot(directory);
        const changes = new Map([
          [pluginFile as "plugin-store/configuration.json", Buffer.from(JSON.stringify(plugin({ cnApiKey: value(secret) })))],
          ["model-visibility.json" as const, Buffer.from(JSON.stringify({ version: 1, hidden: {}, future: ["retain"], disabled: ["plugin.ohmygame.minimax.cn"] }))],
        ]);
        await prepareSettingsTransaction(directory, before, changes);
        await check(directory, before, changes);
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
  }

  async function killAt(directory: string, action: "resume" | "rollback", boundary: string) {
    const child = fork(path.resolve("test/fixtures/minimax-settings-transaction-worker.cjs"), [directory, action, boundary], {
      execPath: "node", execArgv: ["--conditions=ohmygame-source", "--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    let reached = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Worker did not reach checkpoint")), 10_000);
        child.once("message", (message) => { clearTimeout(timeout); if ((message as { checkpoint?: string }).checkpoint === boundary) resolve(); else reject(new Error("Unexpected worker checkpoint")); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Worker exited before checkpoint")); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      });
      reached = true;
    } finally { child.kill("SIGKILL"); const code = await exited; if (reached) expect(code).not.toBe(0); }
  }

  const recoverInFreshProcess = (directory: string) => promisify(execFile)("node", [
    "--conditions=ohmygame-source", "--import", "tsx", "test/fixtures/minimax-settings-transaction-worker.cjs", directory, "resume", "none",
  ]);

  it("recovers actual process termination after either settings write or the completion receipt", async () => {
    for (const boundary of [pluginFile, "model-visibility.json", "applied"]) await transaction(async (directory, before, changes) => {
      expect(await settingsSnapshot(directory)).toEqual(before); // write-ahead intent changes no settings
      await killAt(directory, "resume", boundary);
      await recoverInFreshProcess(directory);
      expect(await resumeSettingsTransaction(directory)).toBe("applied");
      expect(await settingsSnapshot(directory)).toEqual(new Map([...before, ...changes]));
      expect(await resumeSettingsTransaction(directory)).toBe("applied");
      await expect(forgetSettingsTransaction(directory)).rejects.toThrow("not complete");
      await rollbackSettingsTransaction(directory);
      expect(await settingsSnapshot(directory)).toEqual(before);
      await forgetSettingsTransaction(directory);
      await expect(access(path.join(directory, SETTINGS_TRANSACTION_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("persists rollback intent and resumes rollback after termination instead of applying again", async () => {
    for (const boundary of ["rolling-back", pluginFile, "model-visibility.json", "rolled-back"]) await transaction(async (directory, before) => {
      await resumeSettingsTransaction(directory);
      await killAt(directory, "rollback", boundary);
      await recoverInFreshProcess(directory);
      expect(await resumeSettingsTransaction(directory)).toBe("rolled-back");
      expect(await settingsSnapshot(directory)).toEqual(before);
      expect(await rollbackSettingsTransaction(directory)).toBe("rolled-back");
    });
  });

  it("refuses corruption, future journals and changed settings before any recovery write", async () => {
    for (const change of ["checksum", "version", "unknown", "phase", "legacy", "target", "terminal"]) await transaction(async (directory, beforeSettings) => {
      const file = path.join(directory, SETTINGS_TRANSACTION_FILE);
      if (["checksum", "version", "unknown", "phase"].includes(change)) {
        const receipt = JSON.parse(await readFile(file, "utf8"));
        if (change === "checksum") receipt.files[pluginFile].after = Buffer.from("changed").toString("base64");
        if (change === "version") receipt.version = 2;
        if (change === "unknown") receipt.future = true;
        if (change === "phase") receipt.phase = "future-phase";
        // Prove schema/version rejection independently of checksum rejection.
        if (change !== "checksum") {
          const { checksum: _, ...payload } = receipt;
          receipt.checksum = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        }
        await writeFile(file, JSON.stringify(receipt));
      } else {
        if (change === "terminal") await resumeSettingsTransaction(directory);
        const target = change === "legacy" ? "minimax.json" : "model-visibility.json";
        await writeFile(path.join(directory, target), change === "terminal"
          ? beforeSettings.get("model-visibility.json")!
          : JSON.stringify({ version: 1, hidden: {}, independent: secret }));
      }
      const before = await snapshot(directory);
      const reason = change === "checksum" ? "checksum" : ["version", "unknown", "phase"].includes(change) ? "Unsupported" : change === "terminal" ? "Completed" : "conflict";
      await expect(resumeSettingsTransaction(directory)).rejects.toThrow(reason);
      if (change !== "terminal") await expect(rollbackSettingsTransaction(directory)).rejects.toThrow(reason);
      expect(await snapshot(directory)).toEqual(before);
    });
  });

  it("serializes competing operations, keeps an existing journal and rejects premature cleanup", async () => {
    await transaction(async (directory, before, changes) => {
      const receipt = await readFile(path.join(directory, SETTINGS_TRANSACTION_FILE));
      await expect(prepareSettingsTransaction(directory, before, changes)).rejects.toThrow("already exists");
      expect(await readFile(path.join(directory, SETTINGS_TRANSACTION_FILE))).toEqual(receipt);
      const first = resumeSettingsTransaction(directory), second = rollbackSettingsTransaction(directory);
      expect(await first).toBe("applied");
      expect(await second).toBe("rolled-back");
      expect(await settingsSnapshot(directory)).toEqual(before);
      if (process.platform !== "win32") expect((await lstat(path.join(directory, SETTINGS_TRANSACTION_FILE))).mode & 0o777).toBe(0o600);
    });
  });

  it("does not change settings when the write-ahead journal cannot be saved", async () => {
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret } }, async (source) => {
      let staged = "", restored: Record<string, string> | undefined;
      rehearsalHooks.created = (directory) => { staged = directory; };
      rehearsalHooks.beforeRemove = async (target) => { if (target === staged) restored = await snapshot(staged); };
      rehearsalHooks.beforeRename = async (target) => { if (target.endsWith(SETTINGS_TRANSACTION_FILE)) throw new Error(secret); };
      const report = await rehearseMinimaxMigration(source);
      expect(report).toMatchObject({ status: "failed", checks: { sourceUnchanged: true, cleanup: true } });
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(restored).toEqual(await snapshot(source));
    });
  });

  it.skipIf(process.platform === "win32")("refuses a linked recovery journal without modifying its target", async () => {
    await transaction(async (directory) => {
      const file = path.join(directory, SETTINGS_TRANSACTION_FILE), outside = path.join(directory, "outside-journal.json");
      await writeFile(outside, await readFile(file));
      await rm(file);
      await symlink(outside, file);
      const before = await snapshot(directory);
      await expect(resumeSettingsTransaction(directory)).rejects.toThrow("Invalid migration journal file");
      await expect(rollbackSettingsTransaction(directory)).rejects.toThrow("Invalid migration journal file");
      expect(await snapshot(directory)).toEqual(before);
    });
  });

  it("runs the rehearsal through Node without exposing secrets or offering an apply mode", async () => {
    const run = (args: string[]) => promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "scripts/rehearse-minimax-migration.ts", ...args]);
    await fixture({ "minimax.json": { version: 1, cnApiKey: secret } }, async (directory) => {
      const { stdout, stderr } = await run(["--data-dir", directory]);
      expect(JSON.parse(stdout)).toMatchObject({ status: "passed", activation: "held", checks: { rollback: true, cleanup: true } });
      expect(stdout).not.toContain(secret);
      expect(stderr).toBe("");
      await expect(run(["--data-dir", directory, "--apply", secret])).rejects.toMatchObject({ code: 2, stdout: "", stderr: expect.not.stringContaining(secret) });
    });
  });

  it("runs the documented Node command, distinguishes blockers from invalid arguments, and has no apply mode", async () => {
    const run = (args: string[]) => promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "scripts/inspect-minimax-migration.ts", ...args]);
    await fixture({}, async (directory) => {
      const { stdout, stderr } = await run(["--data-dir", directory]);
      expect(JSON.parse(stdout).activation).toBe("held");
      expect(stderr).toBe("");
      const selected = await run(["--data-dir", directory, "--workspace", directory]);
      expect(JSON.parse(selected.stdout)).toMatchObject({ version: 2, scope: "selected-workspaces", activation: "held", canvas: { workspaces: [{ workspace: 1, blockers: [] }] } });
      await expect(run(["--data-dir", directory, "--apply", secret])).rejects.toMatchObject({ code: 2, stdout: "", stderr: expect.not.stringContaining(secret) });
    });
    await fixture({ "minimax.json": `{"${secret}": broken` }, async (directory) => {
      await expect(run(["--data-dir", directory])).rejects.toMatchObject({ code: 1, stdout: expect.not.stringContaining(secret), stderr: "" });
    });
  });
});

describe("MiniMax settings preservation", () => {
  it("retains unknown data when both keys are changed and cleared", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "minimax-preserve-"));
    try {
      const file = path.join(directory, "minimax.json");
      const future = { account: { region: "cn" }, migration: ["pending"] };
      await writeFile(file, JSON.stringify({ version: 1, cnApiKey: "cn", globalApiKey: "global", future }));
      const settings = new MinimaxSettingsStore(directory);
      await settings.load();
      await Promise.all([settings.update("minimax-video-cn", "new-cn"), settings.update("minimax-video-global", "new-global")]);
      const restored = new MinimaxSettingsStore(directory);
      await restored.load();
      expect(restored.key("minimax-video-cn")).toBe("new-cn");
      expect(restored.key("minimax-video-global")).toBe("new-global");
      await Promise.all([restored.clear("minimax-video-cn"), restored.clear("minimax-video-global")]);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, future });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses mutations after unreadable data without replacing the original bytes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "minimax-unreadable-"));
    try {
      const file = path.join(directory, "minimax.json");
      for (const text of ["{broken", "null", "[]", JSON.stringify({ version: 2, cnApiKey: "future" }), JSON.stringify({ version: 1, cnApiKey: { encrypted: "future" } })]) {
        await writeFile(file, text);
        const settings = new MinimaxSettingsStore(directory);
        await expect(settings.load()).rejects.toThrow();
        await expect(settings.update("minimax-video-cn", "replacement")).rejects.toThrow("unreadable");
        await expect(settings.clear("minimax-video-global")).rejects.toThrow("unreadable");
        expect(await readFile(file, "utf8")).toBe(text);
      }
      // Explicitly reloading a repaired file restores normal writes.
      const settings = new MinimaxSettingsStore(directory);
      await settings.load().catch(() => {});
      await writeFile(file, JSON.stringify({ version: 1, globalApiKey: "keep" }));
      await settings.load();
      await settings.update("minimax-video-cn", "cn");
      expect(settings.key("minimax-video-global")).toBe("keep");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("application settings write ownership", () => {
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }
  const entry = { id: "acme/keys", manifest: { capabilities: { secrets: true }, configuration: { cn: { type: "secret" }, global: { type: "secret" } } } } as unknown as PluginIndexEntry;
  const folders: string[] = [];
  afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });
  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-settings-owner-"));
    folders.push(directory);
    const writes = new SettingsWrites();
    const minimax = new MinimaxSettingsStore(directory, writes);
    const models = new ProviderModelSettingsStore(directory, directory, writes);
    const plugins = new PluginValues(path.join(directory, "configuration.json"), writes);
    await Promise.all([minimax.load(), models.load(), plugins.load()]);
    return { directory, writes, minimax, models, plugins };
  }

  it.each(["minimax", "models", "plugins"] as const)("orders %s reload between pending and subsequent saves", async (kind) => {
    const { directory, minimax, models, plugins } = await fixture();
    const store = { minimax, models, plugins }[kind];
    const file = path.join(directory, { minimax: "minimax.json", models: "model-visibility.json", plugins: "configuration.json" }[kind]);
    const update = (second: boolean) => kind === "minimax" ? minimax.update(second ? "minimax-video-global" : "minimax-video-cn", "key")
      : kind === "models" ? models.setEnabled(second ? "second" : "first", false)
      : plugins.update(entry, second ? { global: "key" } : { cn: "key" });
    const arrived = gate(), release = gate();
    const events: string[] = [];
    rehearsalHooks.beforeRename = async (target) => {
      if (target !== file) return;
      events.push("save");
      if (events.length === 1) { arrived.resolve(); await release.promise; }
    };
    rehearsalHooks.beforeRead = (target) => { if (target === file) events.push("load"); };
    const first = update(false);
    const pending: Promise<unknown>[] = [first];
    await arrived.promise;
    try {
      const loaded = store.load();
      pending.push(loaded);
      const second = update(true);
      pending.push(second);
      // No reload may start while the preceding atomic write is still pending.
      expect(events).toEqual(["save"]);
      release.resolve();
      await Promise.all([first, loaded, second]);
      expect(events).toEqual(["save", "load", "save"]);
      if (kind === "minimax") {
        expect(minimax.key("minimax-video-cn")).toBe("key");
        expect(minimax.key("minimax-video-global")).toBe("key");
      } else if (kind === "models") {
        expect(models.isEnabled("first")).toBe(false);
        expect(models.isEnabled("second")).toBe(false);
      } else expect(plugins.forNative(entry)).toEqual({ cn: "key", global: "key" });
      const before = await readFile(file, "utf8");
      await store.load();
      expect(await readFile(file, "utf8")).toBe(before);
    } finally { release.resolve(); await Promise.allSettled(pending); }
  });

  it.each(["minimax", "models", "plugins"] as const)("refuses %s writes after a failed reload and accepts them after repair", async (kind) => {
    const { directory, minimax, models, plugins } = await fixture();
    const store = { minimax, models, plugins }[kind];
    const file = path.join(directory, { minimax: "minimax.json", models: "model-visibility.json", plugins: "configuration.json" }[kind]);
    const update = () => kind === "minimax" ? minimax.update("minimax-video-cn", "key")
      : kind === "models" ? models.setEnabled("first", false) : plugins.update(entry, { cn: "key" });
    const future = JSON.stringify({ version: 2, future: "keep" });
    await writeFile(file, future);
    const failed = store.load().catch(() => {});
    const refused = expect(update()).rejects.toThrow("unreadable");
    await Promise.all([failed, refused]);
    expect(await readFile(file, "utf8")).toBe(future);
    const repaired = { version: 1, future: "keep", ...(kind === "models" ? { hidden: {} } : kind === "plugins" ? { plugins: {} } : {}) };
    await writeFile(file, JSON.stringify(repaired));
    // The write is requested before the repair load finishes; checks must use its result.
    await Promise.all([store.load(), update()]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, future: "keep" });
  });

  it("holds all three stores while removing a provider and clears its credentials without deadlocking", async () => {
    const { directory, minimax, models, plugins } = await fixture();
    await minimax.update("minimax-video-cn", "old-key");
    await models.setDefaultMediaModel("video", { provider: "minimax-video-cn", id: "old-model" });
    const arrived = gate(), release = gate();
    const events: string[] = [];
    const removing = models.removeProviderSettings("minimax-video-cn", async () => {
      arrived.resolve();
      await release.promise;
      await minimax.clear("minimax-video-cn");
      events.push("removed");
    });
    await arrived.promise;
    const saving = plugins.update(entry, { cn: "plugin-key" }).then(() => events.push("plugin"));
    const reconnecting = minimax.update("minimax-video-cn", "replacement-key").then(() => events.push("reconnected"));
    try {
      expect(plugins.storedSecret(entry.id, "cn").occupied).toBe(false);
      release.resolve();
      await Promise.all([removing, saving, reconnecting]);
      expect(events).toEqual(["removed", "plugin", "reconnected"]);
      expect(models.defaultVideoModel()).toBeUndefined();
      expect(JSON.parse(await readFile(path.join(directory, "minimax.json"), "utf8"))).toMatchObject({ cnApiKey: "replacement-key" });
    } finally { release.resolve(); await removing; }
  });

  it("drains nested work after owner failure and rejects recursive access instead of hanging", async () => {
    const writes = new SettingsWrites(), parent = {}, child = {};
    const arrived = gate(), release = gate();
    let finished = false;
    let nested!: Promise<void>;
    const failed = writes.run(parent, async () => {
      await expect(writes.run(parent, async () => {})).rejects.toThrow("already active");
      nested = writes.run(child, async () => { arrived.resolve(); await release.promise; finished = true; });
      throw new Error("owner failed");
    });
    const rejected = expect(failed).rejects.toThrow("owner failed");
    await arrived.promise;
    let entered = false;
    const after = writes.run(child, async () => { entered = true; expect(finished).toBe(true); });
    expect(entered).toBe(false);
    release.resolve();
    await Promise.all([nested, rejected, after]);
  });

  it("queues callbacks that retain an expired owner's async context", async () => {
    const writes = new SettingsWrites(), store = {};
    const trigger = gate();
    let later!: Promise<void>;
    const order: string[] = [];
    await writes.run(store, async () => {
      later = trigger.promise.then(() => writes.run(store, async () => { order.push("later"); }));
    });
    const arrived = gate(), release = gate();
    const current = writes.run(store, async () => { arrived.resolve(); await release.promise; order.push("current"); });
    await arrived.promise;
    trigger.resolve();
    release.resolve();
    await Promise.all([current, later]);
    expect(order).toEqual(["current", "later"]);
  });
});
