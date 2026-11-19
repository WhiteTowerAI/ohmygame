// Checks the plugin API version against the last app release: the minor rises
// at most once per release, so every addition until the next release shares
// one version (docs/plugins.md#api-versions), and docs/plugins.md has its row.
//
// bun run plugin-api:check [--base <git ref>], the base defaulting to the
// newest v* tag reachable from HEAD. CI fetches the newest release tag first.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PLUGIN_HOST_API_VERSION } from "../src/shared/plugin-manifest.js";

const MANIFEST = "src/shared/plugin-manifest.ts";
const VERSION = /PLUGIN_HOST_API_VERSION\s*=\s*"(\d+)\.(\d+)\.(\d+)"/;

const parse = (version: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`${version} isn't a plugin API version`);
  return match.slice(1).map(Number) as [number, number, number];
};

/** What's wrong with `current` when `released` is the last release's API, or nothing. */
export function apiVersionProblems(released: string, current: string, docs: string): string[] {
  const [major, minor] = parse(released), [nowMajor, nowMinor, nowPatch] = parse(current);
  const next = `${major}.${minor + 1}.0`;
  const problems: string[] = [];
  if (nowMajor === major) {
    if (nowMinor < minor) problems.push(`The plugin API is ${current}, older than ${released} in the last release.`);
    else if (nowMinor > minor + 1)
      problems.push(`The plugin API is ${current}, but the last release had ${released}: the minor rises at most once per release, so every addition since shares ${next}.`);
    else if (nowMinor === minor + 1 && nowPatch !== 0) problems.push(`The plugin API is ${current}; the version a release adds is ${next}.`);
  } else if (nowMajor !== major + 1 || nowMinor !== 0 || nowPatch !== 0) {
    problems.push(`The plugin API is ${current}, but the last release had ${released}: a new format starts at ${major + 1}.0.0.`);
  }
  if (!docs.split("\n").some((line) => line.startsWith(`| ${current} |`)))
    problems.push(`docs/plugins.md has no row for ${current} in its API versions table.`);
  return problems;
}

/** The plugin API version at a git ref. */
export function apiVersionAt(ref: string): string {
  const text = execFileSync("git", ["show", `${ref}:${MANIFEST}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const match = VERSION.exec(text);
  if (!match) throw new Error(`${MANIFEST} at ${ref} has no PLUGIN_HOST_API_VERSION`);
  return match.slice(1).join(".");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex === -1
    ? execFileSync("git", ["describe", "--tags", "--match", "v*", "--abbrev=0"], { encoding: "utf8" }).trim()
    : process.argv[baseIndex + 1];
  const released = apiVersionAt(base);
  const problems = apiVersionProblems(released, PLUGIN_HOST_API_VERSION, await readFile("docs/plugins.md", "utf8"));
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`Plugin API ${PLUGIN_HOST_API_VERSION}; ${base} released ${released}.`);
}
