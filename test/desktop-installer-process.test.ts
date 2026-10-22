import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5 }),
      ),
  );
}, 60_000);

describe.skipIf(process.platform !== "win32")(
  "Windows installer process fallback",
  () => {
    async function prepare() {
      const root = await mkdtemp(
        path.join(tmpdir(), "ohmygame-process-check-"),
      );
      temporaryDirectories.push(root);
      const directory = path.join(root, "安装 files & user's folder");
      await mkdir(directory);
      const script = path.join(directory, "check-process.cmd");
      await copyFile("build/check-process.cmd", script);
      return { root, directory, script };
    }

    function check(
      script: string,
      image: string,
      output: string,
      env = process.env,
    ) {
      // Match the raw /D /S /C command line passed by nsExec, including its outer
      // quotes. Verbatim arguments avoid Node re-escaping cmd's nested quotes.
      const result = spawnSync(
        process.env.ComSpec ?? "cmd.exe",
        ["/D", "/S", "/C", `""${script}" "${image}" "${output}""`],
        {
          env,
          windowsVerbatimArguments: true,
          windowsHide: true,
          timeout: 10_000,
        },
      );
      expect(result.error).toBeUndefined();
      return result.status;
    }

    it("returns not running when tasklist succeeds with no matching process", async () => {
      const { directory, script } = await prepare();
      expect(
        check(
          script,
          "OhMyGame-NoSuch345.exe",
          path.join(directory, "processes.txt"),
        ),
      ).toBe(17);
    });

    it("returns running for an existing process", async () => {
      const { directory, script } = await prepare();
      expect(
        check(
          script,
          path.basename(process.execPath),
          path.join(directory, "processes.txt"),
        ),
      ).toBe(0);
    });

    it("does not report a failed tasklist launch as not running", async () => {
      const { root, directory, script } = await prepare();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "systemroot",
        ),
      );
      expect(
        check(script, "OhMyGame.exe", path.join(directory, "processes.txt"), {
          ...env,
          SystemRoot: path.join(root, "missing-windows"),
        }),
      ).toBe(18);
    });

    it("reports an output write failure as a detection error", async () => {
      const { directory, script } = await prepare();
      expect(
        check(
          script,
          "OhMyGame.exe",
          path.join(directory, "missing", "processes.txt"),
        ),
      ).toBe(18);
    });

    it("does not interpret an invalid tasklist filter as an absent process", async () => {
      const { directory, script } = await prepare();
      expect(check(script, "", path.join(directory, "processes.txt"))).toBe(18);
    });
  },
);

// Optional compiler-backed checks exercise the actual x86 nsExec plug-in and
// the macro in both installer and uninstaller contexts. See desktop-releases.md.
const makensis = process.env.OHMYGAME_TEST_MAKENSIS;
describe.skipIf(process.platform !== "win32" || !makensis)(
  "Windows installer NSIS process checks",
  () => {
    it.each(["native", "missing-powershell", "both-checks-fail"] as const)(
      "%s handles silent install and uninstall without a retry loop",
      async (mode) => {
        const root = await mkdtemp(path.join(tmpdir(), "ohmygame-nsis-check-"));
        temporaryDirectories.push(root);
        const logPath = path.join(root, "detection.log");
        let include = await readFile("build/installer.nsh", "utf8");
        include = include.replaceAll(
          "DetailPrint ",
          "!insertmacro TestDetail ",
        );
        if (mode !== "native") {
          // Simulate absent interpreters without touching any system files.
          include = include.replaceAll(
            /\$(?:SYSDIR|WINDIR\\Sysnative)\\WindowsPowerShell\\v1\.0\\powershell\.exe/g,
            "$PLUGINSDIR\\missing-powershell.exe",
          );
        }
        const includePath = path.join(root, "installer.nsh");
        await writeFile(includePath, include);
        const messages = parse(await readFile("build/messages.yml", "utf8"));
        const failureMessage = messages.appProcessCheckFailed.en.replaceAll(
          "\n",
          "$\\r$\\n",
        );
        const executable = path.join(root, "check.exe");
        const uninstaller = path.join(root, "uninstall.exe");
        const commandPath =
          mode === "both-checks-fail"
            ? "$PLUGINSDIR\\missing-cmd.exe"
            : "$SYSDIR\\cmd.exe";
        const source = `
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
Name "OhMyGame installer regression"
OutFile "${executable}"
!include LogicLib.nsh
!define BUILD_RESOURCES_DIR "${path.resolve("build")}"
!define APP_EXECUTABLE_FILENAME "OhMyGame-NoSuch345.exe"
!define PRODUCT_NAME "OhMyGame"
!define isUpdated '1 = 1'
!macro TestDetail TEXT
  FileOpen $R3 "${logPath}" a
  FileSeek $R3 0 END
  FileWrite $R3 '\${TEXT}$\\r$\\n'
  FileClose $R3
!macroend
!include "${includePath}"
Var CmdPath
Var PowerShellPath
LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\English.nlf"
LangString appRunning 1033 "Application running"
LangString appClosing 1033 "Closing application"
LangString appCannotBeClosed 1033 "Application cannot be closed"
LangString appProcessCheckFailed 1033 "${failureMessage}"
Section
  StrCpy $CmdPath "${commandPath}"
  WriteUninstaller "${uninstaller}"
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
Section "Uninstall"
  StrCpy $CmdPath "${commandPath}"
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
`;
        const sourcePath = path.join(root, "check.nsi");
        await writeFile(sourcePath, source);
        const compilation = spawnSync(makensis!, ["/V2", sourcePath], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 20_000,
        });
        expect(compilation.error).toBeUndefined();
        expect(
          compilation.status,
          compilation.stdout + compilation.stderr,
        ).toBe(0);
        const installation = spawnSync(executable, ["/S"], {
          windowsHide: true,
          timeout: 45_000,
        });
        const diagnostics = await readFile(logPath, "utf8").catch(() => "");
        expect(installation.error, diagnostics).toBeUndefined();
        expect(installation.status, diagnostics).toBe(
          mode === "both-checks-fail" ? 2 : 0,
        );
        expect(diagnostics).not.toContain("Waiting for");
        if (mode === "native") {
          expect(diagnostics).toBe("");
        } else {
          expect(diagnostics).toContain("PowerShell process check failed");
          if (mode === "both-checks-fail") {
            expect(diagnostics).toContain("Fallback process check failed");
          }
        }
        const removal = spawnSync(uninstaller, ["/S", `_?=${root}`], {
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 15_000,
        });
        expect(removal.error).toBeUndefined();
        expect(removal.status).toBe(mode === "both-checks-fail" ? 2 : 0);
      },
      60_000,
    );
  },
);
