import { once } from "node:events";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const makensis = process.env.OHMYGAME_TEST_MAKENSIS;
const helper = path.resolve(".runtime/installer-process-helper.exe");
const main = "OhMyGame.exe";
const runtime = ["resources", "runtime", "node", "node.exe"];
const temporaryDirectories: string[] = [];
const processes: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  }
  for (const folder of temporaryDirectories.splice(0)) {
    await rm(folder, { recursive: true, force: true, maxRetries: 5 });
  }
});

function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  return { status: result.status, output: result.stdout + result.stderr };
}

async function folder() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-installer-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function start(executable: string, script: string, args: string[] = []) {
  const child = spawn(executable, ["-e", script, ...args], { windowsHide: true });
  processes.push(child);
  const signal = AbortSignal.timeout(10_000);
  await Promise.race([
    once(child.stdout, "data", { signal }).then(([data]) => expect(data.toString()).toContain("ready")),
    once(child, "exit", { signal }).then(([code]) => { throw new Error(`Fixture exited early: ${code}`); }),
  ]);
  return child;
}

async function startRuntime(directory: string) {
  const node = path.join(directory, ...runtime);
  await mkdir(path.dirname(node), { recursive: true });
  await writeFile(path.join(directory, "resources", "app.asar"), "");
  await copyFile(process.execPath, node);
  return start(node, 'console.log("ready"); setInterval(() => {}, 1000)');
}

describe.skipIf(process.platform !== "win32" || !makensis)("Windows installer process checks", () => {
  it("cleans an orphaned bundled runtime while preserving a neighboring same-name process", async () => {
    const temporary = await folder();
    const old = path.join(temporary, "OhMyGame's 旧安装");
    const target = await startRuntime(old);
    const other = await startRuntime(old + "-other");
    const mainPath = path.join(old, main);
    await copyFile(process.execPath, mainPath);
    const foreground = await start(mainPath, 'console.log("ready"); setInterval(() => {}, 1000)');
    expect(run(helper, ["clean", old, main]).status).toBe(10);
    expect(target.exitCode).toBeNull();
    expect(foreground.exitCode).toBeNull();
    const foregroundExit = once(foreground, "exit");
    foreground.kill();
    await foregroundExit;
    const targetExit = once(target, "exit");
    expect(run(helper, ["probe", old, main]).status).toBe(11);
    const cleanup = run(helper, ["clean", old, main]);
    expect(cleanup.status, cleanup.output).toBe(0);
    expect(cleanup.output).toContain(`exited pid=${target.pid}`);
    expect(cleanup.output).not.toContain(`pid=${other.pid} `);
    await targetExit;
    expect(other.exitCode).toBeNull();
    expect(run(helper, ["probe", old, main]).status).toBe(0);
  }, 90_000);

  it("runs installer and uninstaller macros and records the exact locked file and external owner", async () => {
    const temporary = await folder();
    const old = path.join(temporary, "old installation");
    const current = path.join(temporary, "new installation");
    const target = await startRuntime(old);
    const targetExit = once(target, "exit");
    const file = path.join(old, "locked.txt");
    await writeFile(file, "old payload");
    // The locker is outside the install tree. fs.open on Windows shares deletes,
    // so hold a handle using a child PowerShell process with FileShare.Read.
    const locker = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      '$file = [IO.File]::Open($env:OHMYGAME_TEST_LOCK_FILE, "Open", "Read", "Read"); Write-Output ready; Start-Sleep -Seconds 90',
    ], {
      env: { ...process.env, OHMYGAME_TEST_LOCK_FILE: file },
      windowsHide: true,
    });
    processes.push(locker);
    const [ready] = await once(locker.stdout, "data", { signal: AbortSignal.timeout(10_000) });
    expect(ready.toString()).toContain("ready");

    const executable = path.join(temporary, "check.exe");
    const uninstaller = path.join(temporary, "uninstall.exe");
    const log = path.join(temporary, "installer.log");
    const include = path.resolve("build/installer.nsh");
    const source = `
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "OhMyGame installer regression"
OutFile "${executable}"
!include LogicLib.nsh
!define BUILD_RESOURCES_DIR "${path.resolve("build")}"
!define APP_EXECUTABLE_FILENAME "${main}"
!define UNINSTALL_FILENAME "uninstall.exe"
!define isUpdated '1 = 1'
!include "${include}"
Var omgInstallerLog
Var installationDir
LangString appRunning 1033 "Application running"
LangString appClosing 1033 "Closing application"
LangString appProcessCheckFailed 1033 "Process check failed"
LangString omgForceClose 1033 "Force close"
LangString omgInstalling 1033 "Installing"
LangString omgPreparing 1033 "Preparing"
LangString omgComplete 1033 "Complete"
Page instfiles
Section
  StrCpy $omgInstallerLog "${log}"
  StrCpy $INSTDIR "${current}"
  StrCpy $installationDir "${old}"
  !insertmacro customCheckAppRunning
  !insertmacro customOldUninstallPrepare
  WriteUninstaller "${uninstaller}"
SectionEnd
Section "Uninstall"
  StrCpy $omgInstallerLog "${log}"
  StrCpy $INSTDIR "${old}"
  ClearErrors
  Rename "${file}" "${file}.moved"
  \${If} \${Errors}
    !insertmacro customMoveOldFile "${file}" "${file}.moved"
  \${EndIf}
  IfErrors 0 +3
  SetErrorLevel 2
  Quit
SectionEnd
`;
    const sourcePath = path.join(temporary, "check.nsi");
    await writeFile(sourcePath, source);
    const compile = run(makensis!, ["/V2", sourcePath]);
    expect(compile.status, compile.output).toBe(0);

    const install = run(executable, ["/S"]);
    expect(install.status, install.output).toBe(0);
    await targetExit;

    expect(run(uninstaller, ["/S", `_?=${temporary}`]).status).toBe(2);
    const diagnostics = (await readFile(log, "utf16le")).replace(/^\uFEFF/, "");
    expect(diagnostics).toContain(`old-file-move-failed path=${file} win32-error=32`);
    expect(diagnostics).toContain(`restart-manager-owner pid=${locker.pid}`);
    expect(locker.exitCode).toBeNull();
    const lockerExit = once(locker, "exit");
    locker.kill();
    await lockerExit;
    expect(run(uninstaller, ["/S", `_?=${temporary}`]).status).toBe(0);
    expect(await readFile(file + ".moved", "utf8")).toBe("old payload");
  }, 90_000);
});
