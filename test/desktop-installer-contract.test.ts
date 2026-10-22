import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

  it("connects the pinned extraction hooks and provides both installer languages", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.patchedDependencies["app-builder-lib@26.15.3"]).toBe("patches/app-builder-lib@26.15.3.patch");
    const template = await readFile("node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh", "utf8");
    expect(template.match(/!insertmacro customExtractUsing7za/g)).toHaveLength(2);
    expect(template).toContain("!insertmacro customAppFilesCopied");
    const messages = parse(await readFile("build/messages.yml", "utf8"));
    for (const key of ["omgInstalling", "omgPreparing", "omgExtracting", "omgCopying", "omgFinalizing", "omgComplete"]) {
      expect(messages[key].en).toBeTruthy();
      expect(messages[key].zh_CN).toBeTruthy();
    }
  });

  it("reserves completion for a successful installation", async () => {
    const include = await readFile("build/installer.nsh", "utf8");
    expect(include).toContain("!define MUI_PAGE_CUSTOMFUNCTION_SHOW OhMyGameInstallProgressStart");
    expect(include).toContain("!define MUI_PAGE_CUSTOMFUNCTION_LEAVE OhMyGameInstallProgressFinish");
    const finish = include.slice(include.indexOf("Function OhMyGameInstallProgressFinish"), include.indexOf("!macro customCheckAppRunning"));
    expect(finish.indexOf("IfAbort progress_done")).toBeLessThan(finish.indexOf("StrCpy $omgProgressNext 100"));
    expect(include).not.toContain("PBM_SETMARQUEE");
  });

  it("falls back safely when PowerShell or CIM process detection fails", async () => {
    const include = await readFile("build/installer.nsh", "utf8");
    expect(include).toContain("if ($$running.Count -gt 0) { exit 0 } else { exit 17 }");
    expect(include).toContain("${If} $R0 == 17");
    expect(include).toContain('tasklist /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}"');
    expect(include).toContain('if errorlevel 1 exit /b 18');
    expect(include).toContain('if errorlevel 1 exit /b 17');
    expect(include).not.toMatch(/KillProcess|taskkill|Stop-Process/);
  });

  it("uses recovery wording that remains accurate after a partial install", async () => {
    const messages = await readFile("build/messages.yml", "utf8");
    expect(messages).toContain("Setup did not finish.");
    expect(messages).toContain("Your projects and conversations remain untouched.");
    expect(messages).toContain("重新安装可以修复不完整的程序文件");
    expect(messages).not.toContain("current installation has not been changed");
  });
});
