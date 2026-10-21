import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// nsExec hands the command line to cmd unchanged, so the test must too.
function runCmd(commandLine: string) {
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", [commandLine], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
  return result;
}

async function runProcessFallback(command: string, executable: string) {
  const pluginsDir = await mkdtemp(join(tmpdir(), "ohmygame-installer-"));
  try {
    const systemDir = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    return runCmd(
      command
        .split("${APP_EXECUTABLE_FILENAME}")
        .join(executable)
        .split("$PLUGINSDIR")
        .join(pluginsDir)
        .split("$SYSDIR")
        .join(systemDir),
    );
  } finally {
    await rm(pluginsDir, { recursive: true, force: true });
  }
}

describe("Windows desktop installer safety", () => {
  it("offers install-scope and installation-directory choices", async () => {
    const config = parse(await readFile("electron-builder.yml", "utf8"));
    expect(config.win?.target).toEqual(["nsis"]);
    expect(config.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
    });
    expect(config.nsis).not.toHaveProperty("perMachine");
  });

  it("preserves application data during uninstall and upgrade", async () => {
    const config = parse(await readFile("electron-builder.yml", "utf8"));
    expect(config.nsis).toMatchObject({
      include: "build/installer.nsh",
      deleteAppDataOnUninstall: false,
    });
  });

  it("falls back safely when PowerShell or CIM process detection fails", async () => {
    const include = await readFile("build/installer.nsh", "utf8");
    expect(include).toContain("if ($$running.Count -gt 0) { exit 0 } else { exit 17 }");
    expect(include).toContain("${If} $R0 == 17");
    expect(include).toContain('tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}"');
    expect(include).toContain("(if errorlevel 1 exit /b 18)");
    expect(include).toContain(
      "(if errorlevel 2 exit /b 18) & (if errorlevel 1 exit /b 17)",
    );
    expect(include).not.toMatch(/& if errorlevel/);
    expect(include).not.toMatch(/KillProcess|taskkill|Stop-Process/);
  });

  it.skipIf(process.platform !== "win32")(
    "reports whether the fallback finds a running process",
    async () => {
      const include = await readFile("build/installer.nsh", "utf8");
      const command = include.match(
        /nsExec::Exec `"\$CmdPath" (\/D \/C tasklist [^`]+)`/,
      )?.[1];
      expect(command).toBeDefined();

      const harness = runCmd("/D /C exit /b 17");
      expect(harness.status, harness.stderr).toBe(17);
      const missing = await runProcessFallback(
        command!,
        `ohmygame-missing-${process.pid}.exe`,
      );
      expect(missing.status, missing.stderr).toBe(17);
      const running = await runProcessFallback(
        command!,
        basename(process.execPath),
      );
      expect(running.status, running.stderr).toBe(0);
    },
    // tasklist can take several seconds on a cold CI runner.
    30_000,
  );

  it("uses recovery wording that remains accurate after a partial install", async () => {
    const messages = await readFile("build/messages.yml", "utf8");
    expect(messages).toContain("Setup did not finish.");
    expect(messages).toContain("Your projects and conversations remain untouched.");
    expect(messages).toContain("重新安装可以修复不完整的程序文件");
    expect(messages).not.toContain("current installation has not been changed");
  });
});
