import en from "./locales/en.js";
import zhCN from "./locales/zh-CN.js";
import i18next from "i18next";
import { t } from "./i18n.js";

/**
 * Creation templates save node titles, group names and guide text as plain
 * text in the language they were made in, so files stay readable without the
 * app. These sections hold that text; the editor shows it in the current
 * language instead. Text a person wrote, or edited, matches nothing here and
 * shows as saved.
 */
const TEMPLATE_SECTIONS = [
  "assetCanvasTemplates",
  "effectLibrary",
  "assetCanvas.imagePresets",
  "assetCanvas.pixelPresets",
] as const;
const PART_SEPARATOR = " · ";
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

interface Pattern {
  key: string;
  names: string[];
  expression: RegExp;
}

let index: { exact: Map<string, Set<string>>; patterns: Pattern[] } | undefined;
// Canvases render often; each language keeps its own results.
const cache = new Map<string, Map<string, string>>();

function section(resources: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, part) => (value as Record<string, unknown> | undefined)?.[part],
      resources,
    );
}

function collect(
  value: unknown,
  key: string,
  into: Array<[string, string]>,
): void {
  if (typeof value === "string") into.push([key, value]);
  else if (value && typeof value === "object")
    for (const [name, child] of Object.entries(value))
      collect(child, `${key}.${name}`, into);
}

function templateIndex() {
  if (index) return index;
  const exact = new Map<string, Set<string>>();
  const patterns: Pattern[] = [];
  for (const resources of [en, zhCN]) {
    const entries: Array<[string, string]> = [];
    for (const path of TEMPLATE_SECTIONS)
      collect(section(resources, path), path, entries);
    for (const [key, text] of entries) {
      if (!text.trim()) continue;
      const names = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!);
      if (!names.length) {
        const keys = exact.get(text) ?? new Set<string>();
        keys.add(key);
        exact.set(text, keys);
        continue;
      }
      if (text.includes("\n")) continue;
      const source = text
        .split(PLACEHOLDER)
        .map((piece, position) =>
          position % 2 ? "(.+?)" : piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      patterns.push({ key, names, expression: new RegExp(`^${source}$`) });
    }
  }
  index = { exact, patterns };
  return index;
}

/** One saved phrase in the current language, when it is exactly one template string. */
function translatePhrase(text: string): string | undefined {
  const { exact, patterns } = templateIndex();
  const keys = exact.get(text);
  // Template strings that share a phrase differ only in wording, so the first section's key is used.
  if (keys) return String(t([...keys][0] as never));
  for (const pattern of patterns) {
    const match = pattern.expression.exec(text);
    if (!match) continue;
    const values = Object.fromEntries(
      pattern.names.map((name, position) => {
        const value = match[position + 1]!;
        return [name, translatePhrase(value) ?? value];
      }),
    );
    return String(t(pattern.key as never, values as never));
  }
  return undefined;
}

/** Saved template text in the current language; any other text is returned unchanged. */
export function localizedTemplateText(text: string): string;
export function localizedTemplateText(
  text: string | undefined,
): string | undefined;
export function localizedTemplateText(
  text: string | undefined,
): string | undefined {
  if (!text) return text;
  const results = cache.get(i18next.language) ?? new Map<string, string>();
  cache.set(i18next.language, results);
  let result = results.get(text);
  if (result === undefined) {
    const whole = translatePhrase(text);
    const parts = text.split(PART_SEPARATOR);
    result =
      whole ??
      (parts.length < 2
        ? text
        : parts
            .map((part) => translatePhrase(part) ?? part)
            .join(PART_SEPARATOR));
    results.set(text, result);
  }
  return result;
}
