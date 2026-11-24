import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The check is a dependency-free script without type declarations.
import { compareCounts, countStyleValues } from "../scripts/check-style-values.mjs";

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

// `bun run lint:styles`: written-out values may not grow past the baseline.
describe("style values check", () => {
  it("counts written-out values and leaves tokens, zeros and selectors alone", () => {
    expect(countStyleValues(`
      /* font-size: 99px in a comment */
      .a:hover { font-size: 11px; border-radius: 6px; color: #fff; box-shadow: 0 2px 4px rgb(0 0 0 / 10%); }
      .b { font-size: var(--text-sm); border-radius: var(--radius-md, 8px); color: var(--color-text); }
      .c { border-radius: 0; z-index: 3; font-weight: 600; font: 11px/1.4 Inter, sans-serif; box-shadow: none; }
      .d { --local: #123456; border-top-left-radius: 50%; }
      @media (max-width: 520px) { .e { font-weight: var(--weight-medium); } }
    `)).toEqual({ color: 3, fontSize: 2, fontWeight: 1, radius: 1, shadow: 1, zIndex: 1 });
  });

  it("fails only where a file's count grows, and notes where it shrinks", () => {
    const baseline = { "a.css": { fontSize: 2, color: 1 } };
    expect(compareCounts(baseline, { "a.css": { fontSize: 3, color: 0 }, "new.css": { radius: 1 } })).toEqual({
      grown: [
        { file: "a.css", kind: "fontSize", before: 2, now: 3 },
        { file: "new.css", kind: "radius", before: 0, now: 1 },
      ],
      shrunk: [{ file: "a.css", kind: "color", before: 1, now: 0 }],
    });
  });
});
