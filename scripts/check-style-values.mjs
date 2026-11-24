import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

// The renderer's styles should read the design tokens in src/renderer/ui/tokens.css.
// This counts the values written out instead, per file and kind, and fails
// when a count grows past the baseline: old styles move onto the tokens one
// screen at a time, and new ones start there. Dependency-free, like the other
// checks that run before the app is built.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES = path.join(root, "src/renderer");
const BASELINE = path.join(root, "scripts/style-values-baseline.json");
/** Where the values are defined, so writing them out is the point. */
const TOKENS = "src/renderer/ui/tokens.css";
export const KINDS = ["color", "fontSize", "fontWeight", "radius", "shadow", "zIndex"];

/** Drops every var(...) call, fallbacks included, so only written-out values remain. */
function withoutVars(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("var(", index)) {
      let depth = 0;
      for (; index < value.length; index += 1) {
        if (value[index] === "(") depth += 1;
        else if (value[index] === ")" && --depth === 0) break;
      }
      continue;
    }
    out += value[index];
  }
  return out;
}

const LENGTH = /(^|[\s(,/-])(\d*\.?\d+)(px|rem|em)\b/g;
const hasLength = (value) => [...value.matchAll(LENGTH)].some((match) => Number(match[2]) !== 0);

/** Counts the written-out values in a stylesheet by kind. */
export function countStyleValues(css) {
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/(?:^|[;{\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g)) {
    const [, property, raw] = match;
    // Custom properties outside the tokens are aliases or local knobs; their
    // values count where they are written, as colours below.
    const value = withoutVars(raw.trim());
    counts.color += (value.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).length;
    if (property.startsWith("--")) continue;
    if (property === "font-size" || property === "font") {
      if (hasLength(value)) counts.fontSize += 1;
    } else if (property === "font-weight") {
      if (/\d/.test(value)) counts.fontWeight += 1;
    } else if (/^border(-[a-z]+)*-radius$/.test(property)) {
      if (hasLength(value)) counts.radius += 1;
    } else if (property === "box-shadow") {
      if (hasLength(value)) counts.shadow += 1;
    } else if (property === "z-index") {
      if (/\d/.test(value)) counts.zIndex += 1;
    }
  }
  return counts;
}

async function stylesheets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith(".css") ? [full] : [];
  }));
  return files.flat();
}

export async function countRenderer() {
  const result = {};
  for (const file of (await stylesheets(STYLES)).sort()) {
    const name = path.relative(root, file).split(path.sep).join("/");
    if (name === TOKENS) continue;
    const counts = countStyleValues(await readFile(file, "utf8"));
    const nonzero = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
    if (Object.keys(nonzero).length) result[name] = nonzero;
  }
  return result;
}

/** Where `current` has more written-out values than `baseline` allows, and where it has fewer. */
export function compareCounts(baseline, current) {
  const grown = [];
  const shrunk = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    for (const kind of KINDS) {
      const before = baseline[file]?.[kind] ?? 0;
      const now = current[file]?.[kind] ?? 0;
      if (now > before) grown.push({ file, kind, before, now });
      else if (now < before) shrunk.push({ file, kind, before, now });
    }
  }
  return { grown, shrunk };
}

async function main() {
  const { values } = parseArgs({ options: { update: { type: "boolean", default: false } } });
  const current = await countRenderer();
  if (values.update) {
    await writeFile(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`Style values baseline updated (${Object.keys(current).length} files).`);
    return;
  }
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const { grown, shrunk } = compareCounts(baseline, current);
  if (grown.length) {
    console.error("Styles wrote out values the design tokens already name (src/renderer/ui/tokens.css):");
    for (const { file, kind, before, now } of grown) console.error(`  ${file}: ${kind} ${before} → ${now}`);
    console.error("Use the tokens (var(--color-*), var(--text-*), var(--radius-*), …) instead. If a value truly has no token, add one to tokens.css.");
    process.exitCode = 1;
    return;
  }
  if (shrunk.length) {
    console.log(`Styles use the tokens in ${shrunk.length} more places; run \`bun run lint:styles --update\` to lock that in.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
