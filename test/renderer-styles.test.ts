import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.(css|tsx?)$/.test(entry.name) ? [path] : [];
  });
}

// A var() naming a property nothing sets makes its declaration invalid, so a
// padding or gap quietly becomes 0 rather than failing anywhere visible.
it("only reads CSS variables that a stylesheet or the renderer sets", () => {
  const sources = [...files(join(ROOT, "src/renderer")), ...files(join(ROOT, "src/shared"))];
  const defined = new Set<string>();
  const reads: { name: string; at: string }[] = [];
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    // In code, a property is set as a style key or through setProperty; tokens["--x"] only reads it.
    const declared = file.endsWith(".css") ? /(--[\w-]+)\s*:/g : /["'`](--[\w-]+)["'`]\s*:|setProperty\(\s*["'`](--[\w-]+)/g;
    for (const match of text.matchAll(declared)) defined.add((match[1] ?? match[2])!);
    // A fallback, as in var(--plugin-x, 0), says the property may be missing.
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
      reads.push({ name: match[1]!, at: `${relative(ROOT, file)}:${text.slice(0, match.index).split("\n").length}` });
    }
  }
  expect(reads.filter(({ name }) => !defined.has(name)).map(({ name, at }) => `${name} at ${at}`)).toEqual([]);
});
