import {
  chmod,
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
import { resolveBinary } from "../src/daemon/agent-runtimes/discovery.js";
import * as environment from "../src/daemon/agent-runtimes/environment.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";

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
  vi.stubEnv("SHELL", shell);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(environment, "commonBinaryDirectories").mockReturnValue([]);
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

it("selects the newest CLI, keeps discovery order for ties, and respects manual selection", async () => {
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
  const link = path.join(bin, "codex");
  await symlink(app, link);
  vi.stubEnv("PATH", bin);
  expect(await resolveBinary("codex-cli")).toMatchObject({
    path: link,
    source: "path",
  });
  await chmod(app, 0o600);
  expect(await resolveBinary("codex-cli")).toBeUndefined();
  expect(await resolveBinary("codex-cli", bin)).toBeUndefined();
});

it("finds common install directories and refreshed login shell paths without restarting", async () => {
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

it("shares concurrent shell refreshes and retries a failed shell read", async () => {
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

it("does not return an old status after the chosen executable changes during a probe", async () => {
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
