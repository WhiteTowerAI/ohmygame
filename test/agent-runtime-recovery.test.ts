import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeSettingsStore } from "../src/daemon/agent-runtimes/settings.js";
import {
  processIdentity,
  recoverAgentProcesses,
  trackAgentProcess,
  leaseAgentDirectory,
  recoverAgentDirectories,
} from "../src/daemon/agent-runtimes/process-recovery.js";
import { stageSkills } from "../src/daemon/agent-runtimes/skills.js";
import { terminateProjectProcess } from "../src/daemon/process-lifecycle.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFile: vi.fn(original.execFile) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.mocked(execFile).mockReset();
  vi.mocked(writeFile).mockReset();
});
async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-native-policy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
it("keeps runtimes opt-in and persists native defaults independently of Pi", async () => {
  const root = await folder();
  await writeFile(
    path.join(root, "agent-runtimes.json"),
    JSON.stringify({
      version: 1,
      runtimes: Object.fromEntries(
        ["claude-code-cli", "codex-cli", "opencode-cli"].map((id) => [
          id,
          { isolateUserConfig: true },
        ]),
      ),
    }),
  );
  const store = new AgentRuntimeSettingsStore(root);
  await store.load();
  for (const id of ["claude-code-cli", "codex-cli", "opencode-cli"] as const)
    expect(store.get(id)).not.toHaveProperty("isolateUserConfig");
  expect(store.get("codex-cli").enabled).toBe(false);
  expect(store.get("codex-cli").permissionMode).toBe(":danger-full-access");
  await store.update("codex-cli", {
    enabled: true,
    permissionMode: ":workspace",
  });
  // A mode of another agent is not one of Codex's.
  await expect(
    store.update("codex-cli", { permissionMode: "acceptEdits" }),
  ).rejects.toThrow("not a permission mode");
  await store.setDefaultModel({
    model: { provider: "codex-cli", id: "test" },
    nativeReasoningLevel: "custom-effort",
  });
  const restarted = new AgentRuntimeSettingsStore(root);
  await restarted.load();
  expect(restarted.defaultModel()?.nativeReasoningLevel).toBe("custom-effort");
  expect(restarted.get("codex-cli").enabled).toBe(true);
  // A choice saved after the move to asking nothing is kept.
  expect(restarted.get("codex-cli").permissionMode).toBe(":workspace");
  expect(restarted.get("opencode-cli").enabled).toBe(false);
  const saved = await readFile(path.join(root, "agent-runtimes.json"), "utf8");
  expect(saved).not.toContain("isolateUserConfig");
  expect(JSON.parse(saved).version).toBe(2);
});

it("moves settings saved with OhMyGame's former modes to each agent's own", async () => {
  const root = await folder();
  const file = path.join(root, "agent-runtimes.json");
  const asksNothing = {
    "claude-code-cli": "bypassPermissions",
    "codex-cli": ":danger-full-access",
    "opencode-cli": "allow",
  } as const;
  // Version 1 saved "standard" with any setting, chosen or not.
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      runtimes: {
        "claude-code-cli": { enabled: true, permissionMode: "standard" },
        "codex-cli": { enabled: true, permissionMode: "full" },
        "opencode-cli": { enabled: false },
      },
    }),
  );
  const legacy = new AgentRuntimeSettingsStore(root);
  await legacy.load();
  for (const id of ["claude-code-cli", "codex-cli", "opencode-cli"] as const)
    expect(legacy.get(id).permissionMode).toBe(asksNothing[id]);
  expect(legacy.get("claude-code-cli").enabled).toBe(true);
  // A mode chosen from then on survives restarts.
  await legacy.update("claude-code-cli", { permissionMode: "auto" });
  for (let restart = 0; restart < 2; restart++) {
    const store = new AgentRuntimeSettingsStore(root);
    await store.load();
    expect(store.get("claude-code-cli").permissionMode).toBe("auto");
    expect(store.get("codex-cli").permissionMode).toBe(":danger-full-access");
  }
  // A file without a version is as old as version 1.
  await writeFile(
    file,
    JSON.stringify({
      runtimes: { "codex-cli": { enabled: true, permissionMode: "standard" } },
    }),
  );
  const unversioned = new AgentRuntimeSettingsStore(root);
  await unversioned.load();
  expect(unversioned.get("codex-cli").permissionMode).toBe(
    ":danger-full-access",
  );
  // A later file naming the former modes keeps their meaning in each agent's own words.
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      runtimes: {
        "claude-code-cli": { permissionMode: "standard" },
        "codex-cli": { permissionMode: "standard" },
        "opencode-cli": { permissionMode: "full" },
      },
    }),
  );
  const named = new AgentRuntimeSettingsStore(root);
  await named.load();
  expect(named.get("claude-code-cli").permissionMode).toBe("acceptEdits");
  expect(named.get("codex-cli").permissionMode).toBe(":workspace");
  expect(named.get("opencode-cli").permissionMode).toBe("allow");
});

it("reclaims a verified orphan, preserving a live daemon and unrelated PID identities", async () => {
  const root = await folder();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  trackAgentProcess(root, child);
  cleanup.push(() => terminateProjectProcess(child));
  await once(child, "spawn");
  const identity = (await processIdentity(child.pid!))!;
  expect(identity).toBeTruthy();
  await vi.waitFor(async () => expect(await readdir(root)).toHaveLength(1), {
    timeout: 10_000,
  });
  await recoverAgentProcesses(root);
  expect(await processIdentity(child.pid!)).toBe(identity);
  const journal = path.join(root, `2147483647-${child.pid}.json`);
  await writeFile(
    journal,
    JSON.stringify({
      version: 1,
      owner: 2147483647,
      ownerIdentity: "dead",
      pid: child.pid,
      identity: "different birth time",
    }),
  );
  await recoverAgentProcesses(root);
  expect(await processIdentity(child.pid!)).toBe(identity);
  const closed = once(child, "close");
  await writeFile(
    journal,
    JSON.stringify({
      version: 1,
      owner: 2147483647,
      ownerIdentity: "dead",
      pid: child.pid,
      identity,
    }),
  );
  await recoverAgentProcesses(root);
  await closed;
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

it("preserves a live daemon's private folders while reclaiming verified orphan folders", async () => {
  const root = await folder();
  const live = path.join(root, "live"),
    orphan = path.join(root, "orphan"),
    unknown = path.join(root, "legacy");
  for (const directory of [live, orphan, unknown]) await mkdir(directory);
  await leaseAgentDirectory(live).written;
  await writeFile(
    path.join(orphan, ".owner.json"),
    JSON.stringify({ version: 1, pid: 2147483647, identity: "gone" }),
  );
  await recoverAgentDirectories(root);
  expect((await readdir(root)).sort()).toEqual(["legacy", "live"]);
  expect(await readdir(live)).toEqual([".owner.json"]);
  // A folder released before its lease is written gets none, so removing it
  // cannot race the write.
  const released = leaseAgentDirectory(unknown);
  await released.release();
  await released.written;
  expect(await readdir(unknown)).toEqual([]);
});

// Control lookup completion rather than depending on ps/PowerShell startup speed.
async function controlledRecovery() {
  vi.resetModules();
  const lookups = new EventEmitter();
  type Finish = (identity?: string) => void;
  vi.mocked(execFile).mockImplementation(((
    _command: string,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    lookups.emit("lookup", (identity?: string) =>
      callback(
        identity ? null : new Error("Identity unavailable"),
        identity ?? "",
        "",
      ),
    );
    return { stdin: { end() {} } };
  }) as typeof execFile);
  return {
    runtime: await import("../src/daemon/agent-runtimes/process-recovery.js"),
    nextLookup: () =>
      once(lookups, "lookup").then(([finish]) => finish as Finish),
  };
}

describe("process ownership with delayed identity lookups", () => {
  it("serializes lookups, shares in-flight requests and retries failures", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    await expect(runtime.processIdentity(0)).resolves.toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
    const started = nextLookup();
    const first = runtime.processIdentity(101);
    expect(runtime.processIdentity(101)).toBe(first);
    const second = runtime.processIdentity(102);
    const finishFirst = await started;
    expect(execFile).toHaveBeenCalledOnce();
    const next = nextLookup();
    finishFirst("first identity");
    await expect(first).resolves.toBe("first identity");
    const finishSecond = await next;
    finishSecond();
    await expect(second).resolves.toBeUndefined();
    const retried = nextLookup();
    const retry = runtime.processIdentity(102);
    (await retried)("second identity");
    await expect(retry).resolves.toBe("second identity");
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("keeps the lookup queue usable after a synchronous spawn error", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });
    const failed = runtime.processIdentity(101);
    const started = nextLookup();
    const next = runtime.processIdentity(102);
    await expect(failed).resolves.toBeUndefined();
    (await started)("next identity");
    await expect(next).resolves.toBe("next identity");
  });

  it("retries a failed daemon lookup, shares a successful one and cancels a released lease", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    const root = await folder();
    const started = nextLookup();
    const failed = runtime.leaseAgentDirectory(root);
    (await started)();
    await failed.written;
    expect(await readdir(root)).toEqual([]);
    const removed = path.join(root, "removed");
    await mkdir(removed);
    const retried = nextLookup();
    const lease = runtime.leaseAgentDirectory(root);
    const cancelled = runtime.leaseAgentDirectory(removed);
    const finish = await retried;
    await cancelled.release();
    await rm(removed, { recursive: true });
    finish("daemon identity");
    await Promise.all([lease.written, cancelled.written]);
    expect(
      JSON.parse(await readFile(path.join(root, ".owner.json"), "utf8")),
    ).toEqual({ version: 1, pid: process.pid, identity: "daemon identity" });
    expect(await readdir(root)).toEqual([".owner.json"]);
    await runtime.leaseAgentDirectory(root).written;
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("waits for a lease write already in progress before allowing directory removal", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    const root = await folder();
    const actualWrite = vi.mocked(writeFile).getMockImplementation()!;
    let finishWrite!: () => void;
    const writeAllowed = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    let writing!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      writing = resolve;
    });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      writing();
      await writeAllowed;
      return actualWrite(...args);
    });
    const started = nextLookup();
    const lease = runtime.leaseAgentDirectory(root);
    (await started)("daemon identity");
    await writeStarted;
    const released = vi.fn();
    const release = lease.release().then(released);
    await Promise.resolve();
    expect(released).not.toHaveBeenCalled();
    finishWrite();
    await release;
    await rm(root, { recursive: true });
    await lease.written;
  });

  it("does not journal a process that exits before its identity is known", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    const root = await folder();
    const child = Object.assign(new EventEmitter(), { pid: process.pid });
    runtime.trackAgentProcess(root, child as never);
    const started = nextLookup();
    // Await the async spawn handler, including any journal I/O it might attempt.
    const recording = child.listeners("spawn")[0]!();
    const finish = await started;
    child.emit("close", 0, null);
    finish("daemon identity");
    await recording;
    expect(await readdir(root)).toEqual([]);
  });

  it("removes a journal when its process exits during the write", async () => {
    const { runtime, nextLookup } = await controlledRecovery();
    const root = await folder();
    const child = Object.assign(new EventEmitter(), { pid: process.pid });
    const actualWrite = vi.mocked(writeFile).getMockImplementation()!;
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      child.emit("close", 0, null);
      return actualWrite(...args);
    });
    runtime.trackAgentProcess(root, child as never);
    const started = nextLookup();
    const recording = child.listeners("spawn")[0]!();
    (await started)("daemon identity");
    await recording;
    expect(writeFile).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });
});

it("copies regular Skill files without following links to external credentials", async () => {
  const root = await folder();
  const skill = path.join(root, "source", "test-skill"),
    target = path.join(root, "staged");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Test");
  await writeFile(path.join(skill, "guide.md"), "reference");
  await writeFile(path.join(root, "auth.json"), "DUMMY-CREDENTIAL");
  await symlink(
    path.join(root, "auth.json"),
    path.join(skill, "linked-secret"),
  );
  expect(await stageSkills([skill], target)).toEqual(["test-skill"]);
  expect((await readdir(path.join(target, "test-skill"))).sort()).toEqual([
    "SKILL.md",
    "guide.md",
  ]);
});
