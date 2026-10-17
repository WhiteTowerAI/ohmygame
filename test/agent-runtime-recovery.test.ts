import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  canonicalPath,
  judgeApproval,
  neverTouchPaths,
} from "../src/daemon/agent-runtimes/policy.js";
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

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-native-policy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
it("resolves workspace symlinks, including missing descendants, before protecting credentials", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace"),
    secrets = path.join(root, "secrets");
  await mkdir(workspace);
  await mkdir(secrets);
  await symlink(
    secrets,
    path.join(workspace, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const policy = { workspacePath: workspace, neverTouch: [secrets] };
  expect(
    judgeApproval(
      {
        kind: "file",
        tool: "permissions",
        path: path.parse(workspace).root,
        canAllowSession: false,
      },
      policy,
    ),
  ).toBe("deny");
  expect(
    canonicalPath(path.join(workspace, "linked", "new", "auth.json")),
  ).toBe(path.join(canonicalPath(secrets), "new", "auth.json"));
  expect(
    judgeApproval(
      {
        kind: "file",
        tool: "Read",
        path: "linked/auth.json",
        canAllowSession: true,
      },
      policy,
    ),
  ).toBe("deny");
  expect(
    judgeApproval(
      {
        kind: "command",
        tool: "Bash",
        command: `cat ${path.join(workspace, "linked", "auth.json")}`,
        canAllowSession: true,
      },
      policy,
    ),
  ).toBe("deny");
  expect(
    judgeApproval(
      {
        kind: "command",
        tool: "Bash",
        command: "cat linked/auth.json",
        canAllowSession: true,
      },
      policy,
    ),
  ).toBe("deny");
  for (const command of [
    "node -e 'process.exit()'",
    "npm run build",
    "rg --pre=sh pattern",
    "git status; echo hi",
    "cat $(echo file)",
    // A glob or recursive link-following reaches `linked` without naming it.
    "cat l*/auth.json",
    "cat linke?/auth.json",
    "cat {linked,other}/auth.json",
    "grep -R token .",
    "rg -L token",
    "rg --follow token",
    "ls -lR",
  ]) {
    expect(
      judgeApproval(
        { kind: "command", tool: "Bash", command, canAllowSession: true },
        policy,
      ),
    ).toBe("ask");
  }
  for (const command of [
    "cat notes.txt",
    "grep -rn token src",
    "rg token",
    "ls -la",
  ]) {
    expect(
      judgeApproval(
        { kind: "command", tool: "Bash", command, canAllowSession: true },
        policy,
      ),
    ).toBe("allow");
  }
});
it("protects custom CLI credential roots", () => {
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = "/tmp/custom-codex-auth";
  try {
    expect(neverTouchPaths("/tmp/app")).toContain("/tmp/custom-codex-auth");
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});
it("keeps runtimes opt-in and persists native defaults independently of Pi", async () => {
  const root = await folder();
  const store = new AgentRuntimeSettingsStore(root);
  await store.load();
  expect(store.get("codex-cli").enabled).toBe(false);
  await store.update("codex-cli", { enabled: true });
  await store.setDefaultModel({
    model: { provider: "codex-cli", id: "test" },
    nativeReasoningLevel: "custom-effort",
  });
  const restarted = new AgentRuntimeSettingsStore(root);
  await restarted.load();
  expect(restarted.defaultModel()?.nativeReasoningLevel).toBe("custom-effort");
  expect(restarted.get("codex-cli").enabled).toBe(true);
  expect(restarted.get("opencode-cli").enabled).toBe(false);
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
  const identity = processIdentity(child.pid!)!;
  expect(identity).toBeTruthy();
  expect(await readdir(root)).toHaveLength(1);
  await recoverAgentProcesses(root);
  expect(processIdentity(child.pid!)).toBe(identity);
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
  expect(processIdentity(child.pid!)).toBe(identity);
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
  await leaseAgentDirectory(live);
  await writeFile(
    path.join(orphan, ".owner.json"),
    JSON.stringify({ version: 1, pid: 2147483647, identity: "gone" }),
  );
  await recoverAgentDirectories(root);
  expect((await readdir(root)).sort()).toEqual(["legacy", "live"]);
});

it("allows reading session-owned Skills while keeping sibling app data and Skill writes protected", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace"),
    skills = path.join(root, "data", "session", "skills");
  await mkdir(workspace);
  await mkdir(skills, { recursive: true });
  const context = {
    workspacePath: workspace,
    neverTouch: [path.join(root, "data")],
    readablePaths: [skills],
  };
  const details = {
    kind: "file" as const,
    tool: "Read",
    path: path.join(skills, "references", "guide.md"),
    canAllowSession: false,
  };
  expect(judgeApproval(details, context)).toBe("allow");
  expect(
    judgeApproval(
      { ...details, tool: "external_directory", path: skills },
      context,
    ),
  ).toBe("allow");
  expect(judgeApproval({ ...details, tool: "Write" }, context)).toBe("deny");
  expect(
    judgeApproval(
      { ...details, path: path.join(skills, "..", "config.json") },
      context,
    ),
  ).toBe("deny");
  expect(
    judgeApproval(
      {
        ...details,
        kind: "other",
        tool: "permissions",
        path: undefined,
        paths: [{ path: details.path, access: "read" }],
      },
      context,
    ),
  ).not.toBe("deny");
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
