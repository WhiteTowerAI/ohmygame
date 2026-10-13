import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("Windows desktop installer safety", () => {
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
