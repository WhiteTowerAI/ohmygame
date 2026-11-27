import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENT_RUNTIME_DEFINITIONS } from "../src/daemon/agent-runtimes/definitions.js";
import { resolveBinary, runCli } from "../src/daemon/agent-runtimes/discovery.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

let root: string;
let shellPathFile: string;
let bundled: NonNullable<
  (typeof AGENT_RUNTIME_DEFINITIONS)["codex-cli"]["bundledPaths"]
>["darwin"];
let restoreBundled: () => void;
const services: AgentRuntimeService[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "ohmygame-discovery-"));
  const home = path.join(root, "home");
  await mkdir(home);
  shellPathFile = path.join(root, "shell-path");
  await writeFile(shellPathFile, path.join(root, "initial-bin"));
  const shell = path.join(root, "shell");
  await writeFile(
    shell,
    `#!/bin/sh
printf '__OHMYGAME_PATH__%s__OHMYGAME_PATH__' "$(/bin/cat '${shellPathFile}')"
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", "");
  vi.stubEnv("LOCALAPPDATA", path.join(root, "local"));
  vi.stubEnv("SHELL", shell);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(environment, "commonBinaryDirectories").mockReturnValue([]);
  vi.spyOn(environment, "windowsStorePackageRoots").mockResolvedValue([]);
  // Keep the real app-relative paths, but never inspect the developer's installs.
  bundled = AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths!.darwin!.map(
    (entry) => ({
      ...entry,
      path: entry.path.startsWith("~/")
        ? entry.path
        : path.join(root, entry.path),
    }),
  );
  const original = AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths;
  AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths = {
    [process.platform]: bundled,
  };
  restoreBundled = () => {
    AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths = original;
  };
  await environment.loginShellPath(true);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  restoreBundled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function install(binary: string, version = "1.0.0") {
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'codex-cli ${version}'; else echo 'Logged in using ChatGPT'; fi
`,
    { mode: 0o700 },
  );
  return binary;
}
function bundledPath(index: number) {
  const entry = bundled![index]!;
  return entry.path.startsWith("~/")
    ? path.join(os.homedir(), entry.path.slice(2))
    : entry.path;
}
async function service() {
  const instance = new AgentRuntimeService(
    path.join(root, "data"),
    () => undefined,
  );
  services.push(instance);
  await instance.load();
  return instance;
}

it.each([0, 1, 2, 3])(
  "discovers desktop-bundled CLI %i with a minimal Dock PATH",
  async (index) => {
    const binary = await install(bundledPath(index));
    expect(await resolveBinary("codex-cli")).toMatchObject({
      path: binary,
      source: bundled![index]!.source,
    });
  },
);

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(process.platform === "win32")("selects the newest CLI, keeps discovery order for ties, and respects manual selection", async () => {
  const onPath = await install(path.join(root, "bin", "codex"), "2.0.0");
  const app = await install(bundledPath(0), "3.0.0");
  vi.stubEnv("PATH", path.dirname(onPath));
  expect(await resolveBinary("codex-cli")).toMatchObject({
    path: app,
    source: "codex-app",
  });
  expect(await resolveBinary("codex-cli", onPath)).toMatchObject({
    path: onPath,
    source: "manual",
  });
  await install(onPath, "3.0.0");
  expect(await resolveBinary("codex-cli", undefined, true)).toMatchObject({
    path: onPath,
    source: "path",
  });
});

it("deduplicates symlinks and skips directories and non-executable files", async () => {
  const app = await install(bundledPath(0));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const link = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  await symlink(app, link);
  vi.stubEnv("PATH", bin);
  expect(await resolveBinary("codex-cli")).toMatchObject({
    path: link,
    source: "path",
  });
  if (process.platform !== "win32") {
    await chmod(app, 0o600);
    expect(await resolveBinary("codex-cli")).toBeUndefined();
  }
  expect(await resolveBinary("codex-cli", bin)).toBeUndefined();
});

it.skipIf(process.platform === "win32")("finds common install directories and refreshed login shell paths without restarting", async () => {
  const common = await install(path.join(root, "common", "codex"));
  vi.mocked(environment.commonBinaryDirectories).mockReturnValue([
    path.dirname(common),
  ]);
  expect(await resolveBinary("codex-cli")).toMatchObject({
    path: common,
    source: "common-directory",
  });
  vi.mocked(environment.commonBinaryDirectories).mockReturnValue([]);
  const instance = await service();
  expect((await instance.status("codex-cli")).installed).toBe(false);
  const binary = await install(path.join(root, "new-install", "codex"));
  await writeFile(shellPathFile, path.dirname(binary));
  expect((await instance.status("codex-cli")).installed).toBe(false);
  expect(await instance.status("codex-cli", true)).toMatchObject({
    installed: true,
    binaryPath: binary,
    binarySource: "login-shell",
  });
});

it.skipIf(process.platform === "win32")("shares concurrent shell refreshes and retries a failed shell read", async () => {
  const spy = vi.spyOn(environment, "loginShellPath");
  const binary = await install(path.join(root, "bin", "codex"));
  await writeFile(shellPathFile, path.dirname(binary));
  const first = environment.loginShellPath(true);
  expect(environment.loginShellPath(true)).toBe(first);
  expect(await first).toBe(path.dirname(binary));
  await writeFile(
    process.env.SHELL!,
    `#!/bin/sh
exit 1
`,
  );
  expect(await environment.loginShellPath(true)).toBeUndefined();
  await writeFile(
    process.env.SHELL!,
    `#!/bin/sh
printf '__OHMYGAME_PATH__%s__OHMYGAME_PATH__' '${path.dirname(binary)}'
`,
  );
  expect(await environment.loginShellPath()).toBe(path.dirname(binary));
  spy.mockRestore();
});

it("retains an unavailable manual path and restores automatic discovery only when cleared", async () => {
  const automatic = await install(bundledPath(0));
  const manual = path.join(root, "missing-cli");
  const instance = await service();
  const missing = await instance.update("codex-cli", { binaryPath: manual });
  expect(missing).toMatchObject({
    installed: false,
    configuredBinaryPath: manual,
    diagnostics: [{ code: "invalid-executable" }],
  });
  expect(missing.binaryPath).toBeUndefined();
  expect(missing.diagnostics[0]!.command).toBeUndefined();
  const restored = await instance.update("codex-cli", { binaryPath: "" });
  expect(restored).toMatchObject({
    installed: true,
    binaryPath: automatic,
    binarySource: "codex-app",
  });
  expect(restored.configuredBinaryPath).toBeUndefined();
});

it("reports a found CLI that cannot start as a probe failure, not a missing installation", async () => {
  const binary = await install(bundledPath(0));
  await writeFile(
    binary,
    `#!/missing/interpreter
`,
  );
  const status = await (await service()).status("codex-cli");
  expect(status).toMatchObject({ installed: true, binaryPath: binary });
  expect(status.diagnostics).toContainEqual(
    expect.objectContaining({ code: "probe-failed" }),
  );
  expect(status.diagnostics.some((item) => item.code === "not-installed")).toBe(
    false,
  );
});

it.skipIf(process.platform !== "win32").each([
  ["nested", "bin"],
  ["hoisted", "bin"],
  ["legacy", "codex"],
])(
  "finds the Windows npm native executable in the %s layout",
  async (layout, folder) => {
    AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths = {};
    vi.stubEnv("LOCALAPPDATA", path.join(root, "local"));
    const bin = path.join(root, "npm prefix with spaces");
    const packageRoot = path.join(bin, "node_modules", "@openai", "codex");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
    const vendor =
      layout === "nested"
        ? path.join(
            packageRoot,
            "node_modules",
            "@openai",
            `codex-win32-${arch}`,
          )
        : layout === "hoisted"
          ? path.join(bin, "node_modules", "@openai", `codex-win32-${arch}`)
          : packageRoot;
    const binary = path.join(vendor, "vendor", target, folder, "codex.exe");
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(process.execPath, binary);
    const shim = path.join(bin, "codex.cmd");
    await writeFile(shim, "@echo This shell shim must never run\r\n");
    await writeFile(path.join(bin, "codex.ps1"), "throw 'Must never run'");
    vi.stubEnv("PATH", bin);
    expect(await resolveBinary("codex-cli")).toMatchObject({
      path: binary,
      source: "path",
    });
    expect(await resolveBinary("codex-cli", shim)).toMatchObject({
      path: binary,
      source: "manual",
    });
    expect(
      await resolveBinary("codex-cli", path.join(bin, "codex.ps1")),
    ).toMatchObject({ path: binary, source: "manual" });
    expect(
      await resolveBinary("codex-cli", path.join(root, "missing", "codex.cmd")),
    ).toBeUndefined();
    // A package without its native optional dependency remains unavailable.
    await rm(binary);
    expect(await resolveBinary("codex-cli", shim)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "win32").each(["@opencode/cli", "opencode-ai"])(
  "finds the Windows OpenCode npm native executable in %s",
  async (pkg) => {
    const bin = path.join(root, "npm prefix with spaces");
    const binary = path.join(bin, "node_modules", pkg, "bin", "opencode.exe");
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(process.execPath, binary);
    vi.stubEnv("PATH", bin);
    expect(await resolveBinary("opencode-cli")).toMatchObject({
      path: binary,
      source: "path",
    });
    for (const extension of [".cmd", ".CMD"]) {
      const shim = path.join(bin, `opencode${extension}`);
      await writeFile(shim, `@ECHO off\r\n"%dp0%\\node_modules\\${pkg.replaceAll("/", "\\")}\\bin\\opencode.exe" %*\r\n`);
      expect(await resolveBinary("opencode-cli", shim)).toMatchObject({
        path: binary,
        source: "manual",
      });
    }
  },
);

it.skipIf(process.platform !== "win32").each([".cmd", ".CMD"])(
  "preserves the Node launcher of a manually chosen OpenCode npm %s shim",
  async (extension) => {
    const bin = path.join(root, "npm prefix with spaces");
    const entry = path.join(bin, "node_modules", "opencode-ai", "bin", "opencode.js");
    await mkdir(path.dirname(entry), { recursive: true });
    await copyFile(process.execPath, path.join(bin, "node.exe"));
    await writeFile(entry, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const shim = path.join(bin, `opencode${extension}`);
    await writeFile(shim, '@ECHO off\r\nSET "_prog=node.exe"\r\n"%_prog%" "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*\r\n');
    const binary = await resolveBinary("opencode-cli", shim);
    expect(binary).toMatchObject({ path: shim, source: "manual" });
    const args = ["--model", "provider/model with spaces", 'quote"and&symbols'];
    const result = await runCli(binary!.path, args, environment.agentEnvironment("opencode-cli", binary!.path));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    const signature = binary!.signature;
    await writeFile(entry, 'console.log("Updated OpenCode entry");\n');
    expect((await resolveBinary("opencode-cli", shim))?.signature).not.toBe(signature);
    await rm(entry);
    expect(await resolveBinary("opencode-cli", shim)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "win32")(
  "finds a Windows Claude Code npm shim and accepts it when chosen",
  async () => {
    const bin = path.join(root, "npm prefix with spaces");
    const binary = path.join(
      bin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(process.execPath, binary);
    vi.stubEnv("PATH", bin);
    expect(await resolveBinary("claude-code-cli")).toBeUndefined();
    const shim = path.join(bin, "claude.cmd");
    await writeFile(
      shim,
      '@ECHO off\r\nSETLOCAL\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    );
    expect(await resolveBinary("claude-code-cli")).toMatchObject({
      path: shim,
      source: "path",
    });
    expect(await resolveBinary("claude-code-cli", shim)).toMatchObject({
      path: shim,
      source: "manual",
    });
    const result = await runCli(
      shim,
      ["--version"],
      environment.agentEnvironment("claude-code-cli", shim),
    );
    expect(result.code).toBe(0);
    expect(result.stdout.trim().replace(/^v/, "")).toBe(
      process.versions.bun ?? process.versions.node,
    );

    const powershellShim = path.join(bin, "claude.ps1");
    await writeFile(powershellShim, `& '${binary}' $args\r\n`);
    expect(await resolveBinary("claude-code-cli", powershellShim)).toBeUndefined();
    await writeFile(shim, "@echo Not an npm shim\r\n");
    expect(await resolveBinary("claude-code-cli")).toBeUndefined();
    expect(await resolveBinary("claude-code-cli", shim)).toBeUndefined();
  },
);

it.skipIf(process.platform !== "win32")(
  "lets a chosen Windows Claude Code npm shim start and update",
  async () => {
    const instance = await service();
    const bin = path.join(root, "npm prefix with spaces");
    const shim = path.join(bin, "claude.cmd");
    await mkdir(bin, { recursive: true });
    // The package's own launcher, as older releases ship instead of an .exe.
    await copyFile(process.execPath, path.join(bin, "node.exe"));
    const entry = path.join(
      bin,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(
      entry,
      `import { writeSync } from "node:fs";
if (process.argv[2] === "--version") writeSync(1, "2.1.326 (Claude Code)\\n");
else writeSync(1, JSON.stringify(process.argv.slice(2)));
`,
    );
    await writeFile(
      shim,
      '@ECHO off\r\nSET "_prog=%dp0%\\node.exe"\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
    );
    vi.stubEnv("PATH", bin);
    expect(
      await instance.update("claude-code-cli", { binaryPath: shim }),
    ).toMatchObject({ installed: true, binaryPath: shim });
    expect(await instance.status("claude-code-cli")).toMatchObject({
      installed: true,
      version: "2.1.326",
    });
    const args = ["auth", "status", 'quote"and&symbols'];
    const result = await runCli(
      shim,
      args,
      environment.agentEnvironment("claude-code-cli", shim),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    const signature = (await resolveBinary("claude-code-cli", shim))!.signature;
    await writeFile(entry, `import { writeSync } from "node:fs";
if (process.argv[2] === "--version") writeSync(1, "2.1.400 (Claude Code)\\n");
`);
    expect(
      (await resolveBinary("claude-code-cli", shim))!.signature,
    ).not.toBe(signature);
  },
);

it.skipIf(process.platform !== "win32")(
  "discovers a versioned Windows desktop installation outside PATH",
  async () => {
    AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths = {};
    const local = path.join(root, "local");
    vi.stubEnv("LOCALAPPDATA", local);
    const binary = path.join(
      local,
      "OpenAI",
      "Codex",
      "bin",
      "installation-id",
      "codex.exe",
    );
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(process.execPath, binary);
    expect(await resolveBinary("codex-cli")).toMatchObject({
      path: binary,
      source: "codex-app",
    });
  },
);

it.skipIf(process.platform !== "win32")(
  "discovers the Codex inside the Store package, which cannot be listed",
  async () => {
    AGENT_RUNTIME_DEFINITIONS["codex-cli"].bundledPaths = {};
    vi.stubEnv("LOCALAPPDATA", path.join(root, "local"));
    vi.mocked(environment.windowsStorePackageRoots).mockResolvedValue([
      path.join(root, "WindowsApps", "OpenAI.Codex_1.2.3.0_x64__abc"),
    ]);
    const binary = path.join(
      root,
      "WindowsApps",
      "OpenAI.Codex_1.2.3.0_x64__abc",
      "app",
      "resources",
      "codex.exe",
    );
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(process.execPath, binary);
    expect(await resolveBinary("codex-cli")).toMatchObject({
      path: binary,
      source: "codex-app",
    });
  },
);

it.skipIf(process.platform !== "win32")(
  "reads only the matching Store packages' folders from the registry",
  async () => {
    const sep = path.sep;
    const base = `HKEY_CURRENT_USER${sep}Packages`;
    const key = (name: string) => `${base}${sep}${name}`;
    vi.mocked(execFile).mockImplementation(((
      _command: unknown,
      args: string[],
      _options: unknown,
      callback: (error: null, stdout: string) => void,
    ) => {
      const lines = args.includes("/v")
        ? [
            `    PackageRootFolder    REG_SZ    C:${sep}Apps${sep}${args[1]!.split(sep).at(-1)}`,
          ]
        : [
            key("OpenAI.Codex_1.0.0_x64__abc"),
            key("OpenAI.CodexPrimaryRuntime.v1_x64__def"),
            key("Microsoft.App_x64__ghi"),
          ];
      setImmediate(() => callback(null, lines.join("\r\n")));
      return { stdin: null } as never;
    }) as unknown as typeof execFile);
    vi.mocked(environment.windowsStorePackageRoots).mockRestore();
    expect(await environment.windowsStorePackageRoots("OpenAI.Codex_", true)).toEqual([
      `C:${sep}Apps${sep}OpenAI.Codex_1.0.0_x64__abc`,
    ]);
  },
);

it.skipIf(process.platform === "win32")("does not return an old status after the chosen executable changes during a probe", async () => {
  const old = await install(path.join(root, "old", "codex"));
  const next = await install(path.join(root, "next", "codex"), "2.0.0");
  const gate = path.join(root, "gate");
  const started = path.join(root, "started");
  await writeFile(
    old,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo started > '${started}'
  while [ ! -f '${gate}' ]; do /bin/sleep 0.01; done
  echo 'codex-cli 1.0.0'
else echo 'Logged in using ChatGPT'; fi
`,
  );
  const instance = await service();
  await instance.settings.update("codex-cli", { binaryPath: old });
  const pending = instance.status("codex-cli");
  await expect
    .poll(() => readFile(started, "utf8").catch(() => ""))
    .toContain("started");
  expect(
    await instance.update("codex-cli", { binaryPath: next }),
  ).toMatchObject({ binaryPath: next });
  await writeFile(gate, "ready");
  expect(await pending).toMatchObject({ binaryPath: next, version: "2.0.0" });
});
