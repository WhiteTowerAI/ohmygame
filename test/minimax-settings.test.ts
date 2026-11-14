import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";
import { inspectMinimaxMigration } from "../scripts/inspect-minimax-migration.js";

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
      if (item.isFile()) files[path.relative(directory, path.join(item.parentPath, item.name))] = await readFile(path.join(item.parentPath, item.name), "utf8");
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

  it("runs the documented Node command, distinguishes blockers from invalid arguments, and has no apply mode", async () => {
    const run = (args: string[]) => promisify(execFile)("node", ["--conditions=ohmygame-source", "--import", "tsx", "scripts/inspect-minimax-migration.ts", ...args]);
    await fixture({}, async (directory) => {
      const { stdout, stderr } = await run(["--data-dir", directory]);
      expect(JSON.parse(stdout).activation).toBe("held");
      expect(stderr).toBe("");
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
