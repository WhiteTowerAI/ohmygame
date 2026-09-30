/** Attribute that preview builds add to every element written in surface HTML. */
export const PLAYABLE_SOURCE_ATTRIBUTE = "data-ohmygame-source";

const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

/**
 * Adds `data-ohmygame-source="<file>:<line>:<column>"` to each start tag.
 * This is a tag scanner, not a full HTML parser: it skips comments,
 * declarations, end tags, and raw-text element content, and leaves the rest
 * of the markup byte-for-byte unchanged. Lines and columns are 1-based and
 * point at the tag's `<`.
 */
export function annotatePlayableSourceLocations(
  html: string,
  file: string,
): string {
  const lineStarts = [0];
  for (let index = 0; index < html.length; index += 1) {
    if (html[index] === "\n") lineStarts.push(index + 1);
  }
  const location = (offset: number): string => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return `${file}:${low + 1}:${offset - lineStarts[low]! + 1}`;
  };

  let output = "";
  let copied = 0;
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      index = skipPast(html, "-->", open + 4);
      continue;
    }
    const next = html[open + 1];
    if (next === "!" || next === "?" || next === "/") {
      index = skipPast(html, ">", open + 2);
      continue;
    }
    if (!next || !/[A-Za-z]/.test(next)) {
      index = open + 1;
      continue;
    }
    let nameEnd = open + 1;
    while (nameEnd < html.length && /[^\s/>]/.test(html[nameEnd]!)) nameEnd += 1;
    const tagName = html.slice(open + 1, nameEnd).toLowerCase();
    const tagEnd = startTagEnd(html, nameEnd);
    const tag = html.slice(open, tagEnd);
    if (!hasSourceAttribute(tag)) {
      output +=
        html.slice(copied, nameEnd) +
        ` ${PLAYABLE_SOURCE_ATTRIBUTE}="${escapeAttribute(location(open))}"`;
      copied = nameEnd;
    }
    index = tagEnd;
    if (RAW_TEXT_ELEMENTS.has(tagName) && !tag.endsWith("/>")) {
      index = rawTextEnd(html, tagName, index);
    }
  }
  return output + html.slice(copied);
}

function skipPast(html: string, marker: string, from: number): number {
  const end = html.indexOf(marker, from);
  return end === -1 ? html.length : end + marker.length;
}

/** Returns the offset after the start tag's `>`, honoring quoted attribute values. */
function startTagEnd(html: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  return html.length;
}

function rawTextEnd(html: string, tagName: string, from: number): number {
  const lower = html.toLowerCase();
  const close = lower.indexOf(`</${tagName}`, from);
  return close === -1 ? html.length : close;
}

function hasSourceAttribute(tag: string): boolean {
  return new RegExp(`[\\s/]${PLAYABLE_SOURCE_ATTRIBUTE}\\s*=`, "i").test(tag);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
