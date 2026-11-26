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

export interface PlayableStartTag {
  start: number;
  nameEnd: number;
  end: number;
}

/** Walks complete start tags, skipping comments, declarations, end tags and raw-text content. */
export function* scanPlayableStartTags(html: string): Generator<PlayableStartTag> {
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
    if (tagEnd === undefined) return;
    const tag = html.slice(open, tagEnd);
    yield { start: open, nameEnd, end: tagEnd };
    index = tagEnd;
    if (RAW_TEXT_ELEMENTS.has(tagName) && !tag.endsWith("/>")) {
      index = rawTextEnd(html, tagName, index);
    }
  }
}

function skipPast(html: string, marker: string, from: number): number {
  const end = html.indexOf(marker, from);
  return end === -1 ? html.length : end + marker.length;
}

/** Returns the offset after the start tag's `>`, honoring quoted attribute values. */
function startTagEnd(html: string, from: number): number | undefined {
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
  return undefined;
}

function rawTextEnd(html: string, tagName: string, from: number): number {
  const lower = html.toLowerCase();
  const close = lower.indexOf(`</${tagName}`, from);
  return close === -1 ? html.length : close;
}
