import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isReleaseVersion, parseChangelog } from "../src/shared/changelog.ts";

// Keep this script dependency-free so release validation can run before installation.
try {
  const { values, positionals } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      output: { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals.length > 1) {
    throw new Error(
      "Usage: node scripts/release-notes.mjs [--check | --output file] [version-or-tag]",
    );
  }
  const { version: packageVersion } = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  if (!isReleaseVersion(packageVersion)) {
    throw new Error("package.json must contain a valid SemVer version.");
  }
  const version = (positionals[0] ?? packageVersion).replace(/^v/, "");
  if (version !== packageVersion) {
    throw new Error(
      `Release version ${version} does not match package.json version ${packageVersion}.`,
    );
  }
  const notes = parseChangelog(await readFile("CHANGELOG.md", "utf8")).find(
    (entry) => entry.version === version,
  )?.notes;
  if (notes === undefined) {
    throw new Error(`CHANGELOG.md has no release section for ${version}.`);
  }
  if (values.check && values.output)
    throw new Error("--check and --output cannot be used together.");
  if (values.check) {
    console.log(`Changelog checked for ${version}.`);
  } else if (values.output) {
    await mkdir(path.dirname(values.output), { recursive: true });
    await writeFile(values.output, `${notes}\n`);
  } else {
    process.stdout.write(`${notes}\n`);
  }
} catch (error) {
  console.error(
    `Release notes: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
