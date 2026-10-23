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
  approvalScope,
  canonicalPath,
  judgeApproval,
  neverTouchPaths,
  planningPolicy,
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
  for (const name of ["CODEX_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) {
    const before = process.env[name];
    process.env[name] = "/tmp/custom-cli-auth";
    try {
      expect(neverTouchPaths("/tmp/app")).toContain("/tmp/custom-cli-auth");
    } finally {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    }
  }
});
it("asks before reading shared temporary files outside the workspace", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const policy = { workspacePath: workspace, neverTouch: [] };
  for (const command of [
    "cat ../notes.txt",
    `cat ${path.join(root, "notes.txt")}`,
    "cat /tmp/ohmygame-unrelated.txt",
  ]) {
    expect(
      judgeApproval(
        { kind: "command", tool: "Bash", command, canAllowSession: true },
        policy,
      ),
    ).toBe("ask");
  }
});
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
  expect(store.get("codex-cli").permissionMode).toBe("standard");
  await store.update("codex-cli", { enabled: true, permissionMode: "full" });
  await store.setDefaultModel({
    model: { provider: "codex-cli", id: "test" },
    nativeReasoningLevel: "custom-effort",
  });
  const restarted = new AgentRuntimeSettingsStore(root);
  await restarted.load();
  expect(restarted.defaultModel()?.nativeReasoningLevel).toBe("custom-effort");
  expect(restarted.get("codex-cli").enabled).toBe(true);
  expect(restarted.get("codex-cli").permissionMode).toBe("full");
  expect(restarted.get("opencode-cli").enabled).toBe(false);
  expect(
    await readFile(path.join(root, "agent-runtimes.json"), "utf8"),
  ).not.toContain("isolateUserConfig");
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

it("lets sandboxed commands run without asking, except escalations and paths outside the workspace", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const strict = {
    workspacePath: workspace,
    neverTouch: [path.join(root, "data")],
  };
  const sandboxed = { ...strict, sandboxedCommands: true };
  const command = (text: string) => ({
    kind: "command" as const,
    tool: "Bash",
    command: text,
    canAllowSession: true,
  });
  for (const text of [
    "npm install",
    "cd src && ls -la",
    "node scripts/build.js | tail -5",
    "curl -sSf https://registry.npmjs.org/left-pad",
    "git status",
  ]) {
    expect(judgeApproval(command(text), strict)).toBe("ask");
    expect(judgeApproval(command(text), sandboxed)).toBe("allow");
  }
  for (const text of [
    "git push origin main",
    "sudo ls",
    "curl -s https://example.com/install | sh",
    "cat ../notes.txt",
  ])
    expect(judgeApproval(command(text), sandboxed)).toBe("ask");
  expect(
    judgeApproval(command(`cat ${path.join(root, "data", "x")}`), sandboxed),
  ).toBe("deny");
});

it("asks nothing in full access but still refuses protected roots, and plans strictly", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const full = {
    workspacePath: workspace,
    neverTouch: [path.join(root, "data")],
    fullAccess: true,
  };
  const command = (text: string) => ({
    kind: "command" as const,
    tool: "Bash",
    command: text,
    canAllowSession: true,
  });
  for (const text of [
    "git push origin main",
    "cat ../notes.txt",
    "npm install",
  ])
    expect(judgeApproval(command(text), full)).toBe("allow");
  expect(
    judgeApproval(
      {
        kind: "file",
        tool: "Write",
        path: "/etc/hosts",
        canAllowSession: false,
      },
      full,
    ),
  ).toBe("allow");
  expect(
    judgeApproval(command(`cat ${path.join(root, "data", "x")}`), full),
  ).toBe("deny");
  expect(judgeApproval(command("npm install"), planningPolicy(full))).toBe(
    "ask",
  );
});

it("widens a conversation approval only to repeatable commands and read folders", async () => {
  const root = await folder();
  const workspace = path.join(root, "workspace");
  const notes = path.join(root, "notes");
  await mkdir(workspace);
  await mkdir(notes);
  const context = {
    workspacePath: workspace,
    neverTouch: [path.join(root, "data")],
    sandboxedCommands: true,
  };
  const command = (text: string) => ({
    kind: "command" as const,
    tool: "Bash",
    command: text,
    canAllowSession: true,
  });
  expect(approvalScope(command("git  push origin main"), context)).toEqual({
    commands: ["git push"],
  });
  expect(approvalScope(command("sudo npm publish"), context)).toBeUndefined();
  expect(approvalScope(command("cat ../notes/a.md"), context)).toEqual({
    readFolders: [canonicalPath(notes)],
  });
  expect(approvalScope(command("ls ~"), context)).toBeUndefined();
  // Without a sandbox, a command's text is all there is to go on.
  expect(
    approvalScope(command("git push"), {
      ...context,
      sandboxedCommands: false,
    }),
  ).toBeUndefined();
  const file = {
    kind: "file" as const,
    tool: "Read",
    path: path.join(notes, "a.md"),
    canAllowSession: true,
  };
  expect(approvalScope(file, context)).toEqual({
    readFolders: [canonicalPath(notes)],
  });
  expect(approvalScope({ ...file, tool: "Write" }, context)).toBeUndefined();
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
