import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// Icons take a named size from src/renderer/icons.ts (size="xs" | "sm" | "md" | "lg").
// This counts the icons that still pass a number, per file, and fails when a
// count grows past the baseline, so the old sizes move onto the names one
// screen at a time and new code starts there. Dependency-free, like
// check-style-values.mjs.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(root, "src/renderer");
const BASELINE = path.join(root, "scripts/icon-sizes-baseline.json");

/** Counts JSX elements, named by an import from icons.js, whose size is a number. */
export function countIconSizes(source) {
  const names = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/icons\.js"/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+.*/, "").split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  let count = 0;
  for (const name of names) {
    for (const element of source.matchAll(new RegExp(`<${name}\\b([^<>]*?)/?>`, "g"))) {
      if (/\bsize=\{[^}]*\d/.test(element[1])) count += 1;
    }
  }
  return count;
}

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  }));
  return files.flat();
}

export async function countRenderer() {
  const result = {};
  for (const file of (await sources(RENDERER)).sort()) {
    const count = countIconSizes(await readFile(file, "utf8"));
    if (count) result[path.relative(root, file).split(path.sep).join("/")] = count;
  }
  return result;
}

/** Files whose count grew past `baseline`, and how many counts shrank. */
export function compareIconSizes(baseline, current) {
  const grown = [];
  let shrunk = 0;
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[file] ?? 0;
    const now = current[file] ?? 0;
    if (now > before) grown.push({ file, before, now });
    else if (now < before) shrunk += 1;
  }
  return { grown, shrunk };
}

async function main() {
  const { values } = parseArgs({ options: { update: { type: "boolean", default: false } } });
  const current = await countRenderer();
  if (values.update) {
    await writeFile(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    const total = Object.values(current).reduce((sum, count) => sum + count, 0);
    console.log(`Icon sizes baseline updated (${total} numeric sizes in ${Object.keys(current).length} files).`);
    return;
  }
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const { grown, shrunk } = compareIconSizes(baseline, current);
  if (grown.length) {
    console.error("Icons were given numeric sizes; use size=\"xs\" | \"sm\" | \"md\" | \"lg\" from src/renderer/icons.ts:");
    for (const { file, before, now } of grown) console.error(`  ${file}: ${before} → ${now}`);
    process.exitCode = 1;
    return;
  }
  if (shrunk) console.log(`Icons use named sizes in ${shrunk} more files; run \`bun run lint:icons --update\` to lock that in.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
