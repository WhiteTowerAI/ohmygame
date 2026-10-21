import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ExternalAgentClients,
  type RunCli,
} from "../src/daemon/external-agent-clients.js";
import type { ExternalMcpLauncher } from "../src/shared/external-mcp.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const LAUNCHER: ExternalMcpLauncher = {
  command: "/Users/me/OhMyGame/bin/ohmygame-mcp",
  args: [],
  env: {},
};

async function fixture(
  options: {
    launcher?: ExternalMcpLauncher;
    installed?: string[];
    fail?: string;
  } = {},
) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "ohmygame-external-clients-"),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const skill = path.join(root, "skill");
  await mkdir(skill, { recursive: true });
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: ohmygame-studio\ndescription: Test\n---\n\nv1\n",
  );
  const calls: Array<{ binary: string; args: string[] }> = [];
  const installed = new Set(
    options.installed ?? ["claude-code-cli", "codex-cli"],
  );
  const run: RunCli = async (binary, args) => {
    calls.push({ binary, args: [...args] });
    if (options.fail && args.includes(options.fail))
      return { stdout: "", stderr: "permission denied\n", code: 1 };
    return {
      stdout: "",
      stderr: args.includes("remove") ? "No MCP server found\n" : "",
      code: args.includes("remove") ? 1 : 0,
    };
  };
  const create = (launcher = options.launcher ?? LAUNCHER) =>
    new ExternalAgentClients({
      dataDirectory: path.join(root, "data"),
      launcher,
      skillDirectory: skill,
      resolve: async (runtime) =>
        installed.has(runtime)
          ? { path: `/bin/${runtime}`, env: { HOME: home } }
          : undefined,
      run,
      environment: {},
      home,
    });
  const clients = create();
  await clients.load();
  return { root, home, skill, calls, clients, create };
}

it("adds OhMyGame with each CLI's own command and installs the Skill where it reads Skills", async () => {
  const { home, calls, clients } = await fixture();
  await clients.connect("claude-code");
  await clients.connect("codex");
  expect(calls).toEqual([
    {
      binary: "/bin/claude-code-cli",
      args: ["mcp", "remove", "--scope", "user", "ohmygame-studio"],
    },
    {
      binary: "/bin/claude-code-cli",
      args: [
        "mcp",
        "add",
        "--scope",
        "user",
        "ohmygame-studio",
        "--",
        LAUNCHER.command,
      ],
    },
    { binary: "/bin/codex-cli", args: ["mcp", "remove", "ohmygame-studio"] },
    {
      binary: "/bin/codex-cli",
      args: ["mcp", "add", "ohmygame-studio", "--", LAUNCHER.command],
    },
  ]);
  expect(
    await readFile(
      path.join(home, ".claude", "skills", "ohmygame-studio", "SKILL.md"),
      "utf8",
    ),
  ).toContain("v1");
  expect(
    await readFile(
      path.join(home, ".agents", "skills", "ohmygame-studio", "SKILL.md"),
      "utf8",
    ),
  ).toContain("v1");
  expect(await clients.states()).toEqual([
    { id: "claude-code", available: true, connected: true },
    { id: "codex", available: true, connected: true },
  ]);
});

it("passes the launcher's environment, as Windows needs", async () => {
  const launcher = {
    command: "C:\\OhMyGame\\OhMyGame.exe",
    args: ["main.js", "--data-dir", "C:\\data"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const { calls, clients } = await fixture({ launcher });
  await clients.connect("claude-code");
  await clients.connect("codex");
  expect(calls[1]!.args).toEqual([
    "mcp",
    "add",
    "--scope",
    "user",
    "ohmygame-studio",
    "-e",
    "ELECTRON_RUN_AS_NODE=1",
    "--",
    launcher.command,
    ...launcher.args,
  ]);
  expect(calls[3]!.args).toEqual([
    "mcp",
    "add",
    "ohmygame-studio",
    "--env",
    "ELECTRON_RUN_AS_NODE=1",
    "--",
    launcher.command,
    ...launcher.args,
  ]);
});

it("reports a CLI that is missing or refuses, and needs the desktop app's launcher", async () => {
  const missing = await fixture({ installed: ["claude-code-cli"] });
  await expect(missing.clients.connect("codex")).rejects.toThrow(
    "Codex was not found on this computer",
  );
  expect((await missing.clients.states())[1]).toEqual({
    id: "codex",
    available: false,
    connected: false,
  });

  const refusing = await fixture({ fail: "add" });
  await expect(refusing.clients.connect("claude-code")).rejects.toThrow(
    "Claude Code could not add OhMyGame: permission denied",
  );
  expect((await refusing.clients.states())[0]!.connected).toBe(false);

  const browser = new ExternalAgentClients({
    dataDirectory: missing.root,
    skillDirectory: missing.skill,
    resolve: async () => ({ path: "/bin/x", env: {} }),
    run: async () => ({ stdout: "", stderr: "", code: 0 }),
  });
  await expect(browser.connect("claude-code")).rejects.toThrow(
    "needs the OhMyGame desktop app",
  );
});

it("removes the entry and the Skill on disconnect, keeping a folder another client still reads", async () => {
  const { home, calls, clients, create } = await fixture();
  await clients.connect("codex");
  await clients.disconnect("codex");
  expect(calls.at(-1)).toEqual({
    binary: "/bin/codex-cli",
    args: ["mcp", "remove", "ohmygame-studio"],
  });
  await expect(
    stat(path.join(home, ".agents", "skills", "ohmygame-studio")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await clients.states())[1]!.connected).toBe(false);

  // The choice survives a restart.
  await clients.connect("claude-code");
  const restarted = create();
  await restarted.load();
  expect((await restarted.states()).map((state) => state.connected)).toEqual([
    true,
    false,
  ]);
});

it("leaves a person's own Skill of the same name alone", async () => {
  const { home, clients } = await fixture();
  const own = path.join(home, ".agents", "skills", "ohmygame-studio");
  await mkdir(own, { recursive: true });
  await writeFile(path.join(own, "SKILL.md"), "---\nname: my-own\n---\n");
  await clients.connect("codex");
  await clients.disconnect("codex");
  expect(await readFile(path.join(own, "SKILL.md"), "utf8")).toContain(
    "my-own",
  );
});

it("updates the Skill and reconnects with a moved launcher at startup", async () => {
  const { home, skill, calls, clients, create } = await fixture();
  await clients.connect("claude-code");
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: ohmygame-studio\ndescription: Test\n---\n\nv2\n",
  );
  const same = create();
  await same.load();
  await same.refresh();
  expect(calls).toHaveLength(2);
  expect(
    await readFile(
      path.join(home, ".claude", "skills", "ohmygame-studio", "SKILL.md"),
      "utf8",
    ),
  ).toContain("v2");

  const moved = create({
    command: "/Applications/OhMyGame.app/bin/ohmygame-mcp",
    args: [],
    env: {},
  });
  await moved.load();
  await moved.refresh();
  expect(calls.at(-1)!.args).toContain(
    "/Applications/OhMyGame.app/bin/ohmygame-mcp",
  );
});

it("keeps an existing Skill folder that has no SKILL.md", async () => {
  const { home, clients } = await fixture();
  const own = path.join(home, ".agents", "skills", "ohmygame-studio");
  await mkdir(own, { recursive: true });
  await writeFile(path.join(own, "notes.txt"), "my notes");
  await clients.connect("codex");
  await clients.disconnect("codex");
  expect(await readFile(path.join(own, "notes.txt"), "utf8")).toBe("my notes");
});

it("leaves a symlinked Skill alone", async () => {
  const { home, skill, clients } = await fixture();
  const own = path.join(home, ".agents", "skills", "ohmygame-studio");
  await mkdir(path.dirname(own), { recursive: true });
  await symlink(skill, own, process.platform === "win32" ? "junction" : "dir");
  await clients.connect("codex");
  await clients.disconnect("codex");
  expect(await readFile(path.join(own, "SKILL.md"), "utf8")).toContain("v1");
});
