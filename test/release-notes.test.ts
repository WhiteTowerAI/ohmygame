import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const version = "0.0.0-beta.4.7";
const body =
  "### Fixed\n\n- Recover interrupted requests. ([#211](https://github.com/WhiteTowerAI/ohmygame/pull/211))";
const changelog = `# Changelog\n\n## [${version}] - 2026-10-13\n\n${body}\n`;
const script = path.resolve("scripts/release-notes.mjs");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(markdown = changelog, packageVersion = version) {
  const directory = mkdtempSync(path.join(tmpdir(), "ohmygame release-notes "));
  directories.push(directory);
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ version: packageVersion }),
  );
  writeFileSync(path.join(directory, "CHANGELOG.md"), markdown);
  return directory;
}

function runNotes(
  markdown = changelog,
  args: string[] = [],
  packageVersion = version,
) {
  return spawnSync("node", [script, ...args], {
    cwd: fixture(markdown, packageVersion),
    encoding: "utf8",
  });
}

describe("release notes CLI", () => {
  it.each([{ args: [] }, { args: [version] }, { args: [`v${version}`] }])(
    "extracts the exact release body with arguments $args",
    ({ args }) => {
      const result = runNotes(changelog, args);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${body}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it("checks the current version without printing release content", () => {
    const result = runNotes(changelog, ["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`Changelog checked for ${version}.\n`);
  });

  it("writes the exact notes to the desktop packaging resource", () => {
    const directory = fixture();
    const result = spawnSync(
      "node",
      [script, "--output", ".runtime/release-notes.md"],
      { cwd: directory, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(
      readFileSync(
        path.join(directory, ".runtime", "release-notes.md"),
        "utf8",
      ),
    ).toBe(`${body}\n`);
  });

  it("excludes earlier releases and normalizes Windows line endings", () => {
    const markdown = `${changelog}\n## [0.0.0-beta.4.6] - 2026-10-12\n\n- Previous release.\n`;
    const result = runNotes(markdown.replace(/\n/g, "\r\n"));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${body}\n`);
  });

  it("preserves code examples containing release-shaped headings", () => {
    const example = `${body}\n\n\`\`\`markdown\n## [${version}] - 2026-10-13\n\`\`\``;
    const result = runNotes(`## [${version}] - 2026-10-13\n\n${example}\n`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${example}\n`);
  });

  it("preserves literal HTML comments in inline and fenced code", () => {
    const notes =
      "### Fixed\n\n- Preserve `<!-- scene -->` in HTML.\n\n```html\n<!-- scene -->\n<div>Scene</div>\n```";
    const result = runNotes(`## [${version}] - 2026-10-13\n\n${notes}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${notes}\n`);
  });

  it("rejects a tag that differs from the package version without emitting notes", () => {
    const result = runNotes(changelog, ["v0.0.0-beta.4.8"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not match package.json");
  });

  it.each([
    ["missing", "# Changelog\n", "no release section"],
    ["duplicate", `${changelog}\n${changelog}`, "Duplicate changelog section"],
    ["empty", `## [${version}] - 2026-10-13\n`, "is empty"],
    [
      "headings and comments only",
      `## [${version}] - 2026-10-13\n\n### Fixed\n\n<!-- TODO: fill this -->\n`,
      "is empty",
    ],
    ["missing date", `## [${version}]\n\n${body}`, "valid YYYY-MM-DD date"],
    [
      "invalid date",
      `## [${version}] - 2026-02-29\n\n${body}`,
      "valid YYYY-MM-DD date",
    ],
    [
      "invalid heading",
      `## ${version} - 2026-10-13\n\n${body}`,
      "Invalid changelog heading",
    ],
    [
      "invalid version",
      `## [0.0.0-beta.04] - 2026-10-13\n\n${body}`,
      "Invalid changelog version",
    ],
    [
      "unclosed code fence",
      `${changelog}\n\`\`\`markdown\n## [0.0.0-beta.4.6] - 2026-10-12\n\n- Previous release.`,
      "Unclosed code fence",
    ],
  ])("rejects %s release notes", (_name, markdown, message) => {
    const result = runNotes(markdown);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it.each(["1.0.0", "1.2.3-beta.1", "1.2.3+build.5"])(
    "supports SemVer release %s",
    (releaseVersion) => {
      const result = runNotes(
        `## [${releaseVersion}] - 2024-02-29\n\n${body}`,
        [`v${releaseVersion}`],
        releaseVersion,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`${body}\n`);
    },
  );

  it.each(["v01.0.0", "v1.0.0-beta.01", "latest"])(
    "rejects invalid version argument %s",
    (argument) => {
      const result = runNotes(changelog, [argument]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("does not match package.json");
    },
  );

  it.each(["01.0.0", "1.0.0-beta.01"])(
    "rejects invalid package version %s",
    (packageVersion) => {
      const result = runNotes(changelog, [], packageVersion);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("valid SemVer");
    },
  );
});

describe("desktop release publication", () => {
  const workflow = parse(
    readFileSync(".github/workflows/release-desktop.yml", "utf8"),
  );

  it("requires changelog validation before packaging", () => {
    const jobs = workflow.jobs;
    expect(jobs.windows.needs).toBe("release-notes");
    expect(jobs.macos.needs).toBe("release-notes");
  });

  it.each([`v${version}`, "v0.0.0-beta.4.8"])(
    "prepares notes locally for tag %s",
    (tag) => {
      const directory = fixture();
      const temporary = path.join(directory, "temp");
      mkdirSync(temporary);
      mkdirSync(path.join(directory, "scripts"));
      writeFileSync(
        path.join(directory, "scripts", "release-notes.mjs"),
        readFileSync(script),
      );
      mkdirSync(path.join(directory, "src", "shared"), { recursive: true });
      writeFileSync(
        path.join(directory, "src", "shared", "changelog.ts"),
        readFileSync("src/shared/changelog.ts"),
      );
      const prepare = workflow.jobs.release.steps.find(
        (step: any) => step.name === "Prepare release notes",
      );
      const result = spawnSync("bash", ["-e", "-c", prepare.run], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, RELEASE_TAG: tag, RUNNER_TEMP: temporary },
      });
      const notes = readFileSync(
        path.join(temporary, "release-notes.md"),
        "utf8",
      );
      if (tag === `v${version}`) {
        expect(result.status, result.stderr).toBe(0);
        expect(notes).toBe(`${body}\n`);
      } else {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("does not match package.json");
        expect(notes).toBe("");
      }
    },
  );

  it.each([false, true])(
    "publishes changelog text when the release already exists: %s",
    (exists) => {
      const directory = fixture();
      const notesFile = path.join(directory, "release notes.md");
      writeFileSync(notesFile, `${body}\n`);
      mkdirSync(path.join(directory, "bin"));
      mkdirSync(path.join(directory, "release-assets"));
      for (const extension of ["exe", "dmg", "zip"]) {
        writeFileSync(
          path.join(directory, "release-assets", `OhMyGame.${extension}`),
          "fixture",
        );
      }
      const logFile = path.join(directory, "gh.jsonl");
      writeFileSync(
        path.join(directory, "bin", "gh"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes-file");
fs.appendFileSync(process.env.GH_TEST_LOG, JSON.stringify({ args, notes: notesIndex < 0 ? null : fs.readFileSync(args[notesIndex + 1], "utf8") }) + "\\n");
if (args[1] === "view") process.exit(process.env.GH_TEST_EXISTS === "true" ? 0 : 1);
`,
        { mode: 0o755 },
      );
      const publish = workflow.jobs.release.steps.find(
        (step: any) => step.name === "Publish GitHub prerelease",
      );
      const result = spawnSync("bash", ["-e", "-c", publish.run], {
        cwd: directory,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}`,
          GITHUB_REF_NAME: `v${version}`,
          RELEASE_NOTES_FILE: notesFile,
          GH_TEST_LOG: logFile,
          GH_TEST_EXISTS: String(exists),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.args[1])).toEqual(
        exists ? ["view", "upload", "edit"] : ["view", "create"],
      );
      const publication = calls.at(-1);
      expect(publication.notes).toBe(`${body}\n`);
      expect(publication.args).toContain(`v${version}`);
      expect(publication.args).not.toContain("--generate-notes");
      if (!exists) expect(publication.args).toContain("--verify-tag");
    },
  );
});
