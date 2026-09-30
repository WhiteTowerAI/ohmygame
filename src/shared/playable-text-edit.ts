/** A `<file>:<line>:<column>` source location from a preview build. */
export interface PlayableSourceLocation {
  file: string;
  line: number;
  column: number;
}

export function parsePlayableSourceLocation(value: string): PlayableSourceLocation | undefined {
  const match = /^(.+):(\d+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (line < 1 || column < 1) return undefined;
  return { file: match[1]!, line, column };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

/**
 * Replaces the text of the element whose start tag is at `location` in
 * surface HTML. The element must hold only text, and that text must still
 * read `before`, so a stale preview or text set by a script is never
 * overwritten. Surrounding whitespace is kept. Returns undefined when the
 * edit cannot be made in place.
 */
export function replacePlayableElementText(
  html: string,
  location: Pick<PlayableSourceLocation, "line" | "column">,
  before: string,
  after: string,
): string | undefined {
  const start = offsetOf(html, location.line, location.column);
  if (start === undefined || html[start] !== "<") return undefined;
  const tag = /^<([A-Za-z][\w-]*)/.exec(html.slice(start))?.[1];
  if (!tag) return undefined;
  const open = startTagEnd(html, start);
  if (open === undefined || html[open - 2] === "/") return undefined;
  const close = html.indexOf("<", open);
  if (close < 0 || html.slice(close, close + tag.length + 2).toLowerCase() !== `</${tag.toLowerCase()}`) return undefined;
  const content = html.slice(open, close);
  if (normalize(decode(content)) !== normalize(before)) return undefined;
  const leading = /^\s*/.exec(content)![0];
  const trailing = /\s*$/.exec(content.slice(leading.length))![0];
  return `${html.slice(0, open)}${leading}${escapeText(after.trim())}${trailing}${html.slice(close)}`;
}

function offsetOf(html: string, line: number, column: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = html.indexOf("\n", offset);
    if (next < 0) return undefined;
    offset = next + 1;
  }
  const result = offset + column - 1;
  return result < html.length ? result : undefined;
}

/** The offset just after a start tag's `>`, skipping quoted attribute values. */
function startTagEnd(html: string, start: number): number | undefined {
  let quote: string | undefined;
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return undefined;
}

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
