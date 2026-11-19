import { execFile } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PAUSE_TIMEOUT_MS = 10 * 60_000;

function pauseFile(dataDirectory: string): string {
  return path.join(dataDirectory, "external-mcp", "windows-update.pause");
}

export async function windowsMcpUpdatePaused(dataDirectory: string): Promise<boolean> {
  const marker = await stat(pauseFile(dataDirectory)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  return !!marker && Date.now() - marker.mtimeMs < PAUSE_TIMEOUT_MS;
}

export async function pauseWindowsMcpLaunchers(dataDirectory: string, currentVersion: string): Promise<() => Promise<void>> {
  const file = pauseFile(dataDirectory);
  await writeFile(file, currentVersion, { mode: 0o600 });
  return () => rm(file, { force: true });
}

export async function clearWindowsMcpUpdatePause(dataDirectory: string, currentVersion: string): Promise<void> {
  const file = pauseFile(dataDirectory);
  const version = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (version && version !== currentVersion) await rm(file, { force: true });
}

/** Detect even launchers from older releases, which cannot respond to the pause file. */
export async function hasWindowsMcpLaunchers(executable: string): Promise<boolean> {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name = 'OhMyGame.exe'"
    $launchers = @($processes | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.Equals($env:OHMYGAME_UPDATE_EXE, 'OrdinalIgnoreCase') -and
      $_.CommandLine -match '(?i)\\external-mcp-main\.js"?\s+--data-dir\s'
    })
    [Console]::WriteLine($launchers.Count)
  `;
  const { stdout } = await exec(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
  ], {
    env: { ...process.env, OHMYGAME_UPDATE_EXE: executable },
    timeout: 15_000,
    windowsHide: true,
  });
  const count = stdout.trim();
  if (!/^\d+$/.test(count)) throw new Error("Invalid Windows MCP process check result");
  return Number(count) > 0;
}

interface WindowsMcpUpdateOptions {
  busy: () => Promise<boolean>;
  pauseTools: () => Promise<boolean>;
  resumeTools: () => Promise<void>;
  hasLaunchers: () => Promise<boolean>;
  confirmDisconnect: () => Promise<boolean>;
  showBusy: () => Promise<void>;
  showBlocked: () => Promise<void>;
  pauseLaunchers: () => Promise<() => Promise<void>>;
  shutdown: () => Promise<void>;
  wait?: () => Promise<void>;
}

export async function prepareWindowsMcpUpdate(options: WindowsMcpUpdateOptions): Promise<false | void> {
  let paused = false;
  let resumeLaunchers: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  async function resume(): Promise<void> {
    const results = await Promise.allSettled([resumeLaunchers?.(), paused ? options.resumeTools() : undefined]);
    for (const result of results) {
      if (result.status === "rejected") console.warn("Could not resume external MCP after update attempt", result.reason);
    }
  }
  try {
    if (await options.busy()) {
      await options.showBusy();
      return false;
    }
    if (await options.hasLaunchers() && !await options.confirmDisconnect()) return false;
    paused = true;
    if (!await options.pauseTools()) {
      paused = false;
      await options.showBusy();
      return false;
    }
    resumeLaunchers = await options.pauseLaunchers();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!await options.hasLaunchers()) {
        shuttingDown = true;
        break;
      }
      await (options.wait?.() ?? sleep(500));
    }
  } catch (error) {
    console.warn("Could not verify Windows MCP update readiness", error);
  } finally {
    if (!shuttingDown) await resume();
  }
  if (!shuttingDown) {
    await options.showBlocked();
    return false;
  }
  try {
    await options.shutdown();
  } catch (error) {
    await resume();
    throw error;
  }
}
