import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ExternalMcpLauncher } from "../shared/external-mcp.js";

export interface LauncherInstallOptions {
  /** `<userData>/bin`, which stays put when the app moves or updates. */
  binDirectory: string;
  /** The app's executable, which runs the launcher as Node. */
  executable: string;
  /** The compiled `external-mcp-main.js`. */
  entry: string;
  dataDirectory: string;
  /** The app folder Electron needs in development; packaged apps start without it. */
  appPath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Writes `ohmygame-mcp` for clients to start and returns how to start it.
 * On macOS and Linux it is a shell script rewritten at every start, so a
 * client's configuration keeps working after the app moves. Windows clients
 * start the executable directly: Node no longer runs `.cmd` files without a
 * shell, and the installer keeps the executable's path across updates.
 */
export async function installExternalMcpLauncher(
  options: LauncherInstallOptions,
): Promise<ExternalMcpLauncher> {
  const args = [
    options.entry,
    "--data-dir",
    options.dataDirectory,
    ...(options.appPath ? ["--app", options.appPath] : []),
  ];
  if ((options.platform ?? process.platform) === "win32")
    return {
      command: options.executable,
      args,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  const file = path.join(options.binDirectory, "ohmygame-mcp");
  const script = [
    "#!/bin/sh",
    "# Starts OhMyGame's MCP server for Claude Code, Codex and other agents. OhMyGame rewrites this file.",
    `ELECTRON_RUN_AS_NODE=1 exec ${[options.executable, ...args].map(shellQuote).join(" ")} "$@"`,
    "",
  ].join("\n");
  await mkdir(options.binDirectory, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, script, { mode: 0o755 });
  await chmod(temporary, 0o755);
  await rename(temporary, file);
  return { command: file, args: [], env: {} };
}

/**
 * Records that the app is running, so a launcher that finds no endpoint while
 * the daemon starts or restarts waits for it instead of starting a second app.
 * Returns the cleanup for quitting.
 */
export async function markExternalMcpApp(
  dataDirectory: string,
  pid = process.pid,
): Promise<() => Promise<void>> {
  const file = path.join(dataDirectory, "external-mcp", "app.json");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ version: 1, pid })}\n`, {
    mode: 0o600,
  });
  return async () => {
    // A later app may have replaced the record.
    const current = await readFile(file, "utf8").then(
      (text) => (JSON.parse(text) as { pid?: unknown }).pid,
      () => undefined,
    );
    if (current === pid) await rm(file, { force: true });
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
