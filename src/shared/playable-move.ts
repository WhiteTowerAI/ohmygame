import { offsetOf, startTagEnd, type PlayableSourceLocation } from "./playable-text-edit.js";

/**
 * Where a moved element sits, as a CSS `translate` from where its layout puts
 * it, in hundredths of the screen: `x` in cqw and `y` in cqh. The Project
 * Style makes each Node's root a size container, so the offset holds at any
 * screen size.
 */
export interface PlayableTranslate {
  x: number;
  y: number;
}

/** `translate: 3.5cqw -2cqh`, or undefined for no offset. */
export function playableTranslateValue(translate: PlayableTranslate): string | undefined {
  const x = roundOffset(translate.x);
  const y = roundOffset(translate.y);
  if (!x && !y) return undefined;
  return `${x ? `${x}cqw` : "0"} ${y ? `${y}cqh` : "0"}`;
}

/** Rounds to hundredths of a cqw or cqh, which is finer than a pixel at any screen size. */
export function roundOffset(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Reads an inline `translate` back as an offset, converting pixels with the
 * screen `size`. Undefined when it holds anything else, such as a percentage
 * of the element or a z offset, which a move cannot keep.
 */
export function parsePlayableTranslate(value: string, size: { width: number; height: number }): PlayableTranslate | undefined {
  const text = value.trim();
  if (!text || text === "none") return { x: 0, y: 0 };
  const [first, second, ...rest] = text.split(/\s+/);
  if (rest.length) return undefined;
  const x = readOffset(first!, "cqw", size.width);
  const y = second === undefined ? 0 : readOffset(second, "cqh", size.height);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function readOffset(token: string, unit: "cqw" | "cqh", length: number): number | undefined {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(cqw|cqh|px)?$/.exec(token);
  if (!match) return undefined;
  const number = Number(match[1]);
  if (!match[2]) return number === 0 ? 0 : undefined;
  if (match[2] === unit) return number;
  if (match[2] === "px" && length > 0) return (number / length) * 100;
  return undefined;
}

/**
 * Sets the `translate` declaration in the `style` attribute of the element
 * whose start tag is at `location` in surface HTML, and keeps its other
 * declarations. No offset removes the declaration, and the attribute when
 * nothing else is left. The tag must still be a `tag` element, so a stale
 * preview never moves another element. Returns undefined when the edit
 * cannot be made in place.
 */
export function setPlayableElementTranslate(
  html: string,
  location: Pick<PlayableSourceLocation, "line" | "column">,
  tag: string,
  translate: PlayableTranslate,
): string | undefined {
  const start = offsetOf(html, location.line, location.column);
  if (start === undefined || html[start] !== "<") return undefined;
  const name = /^<([A-Za-z][\w-]*)/.exec(html.slice(start))?.[1];
  if (!name || name.toLowerCase() !== tag.toLowerCase()) return undefined;
  const end = startTagEnd(html, start);
  if (end === undefined) return undefined;
  const style = findStyleAttribute(html, start + 1 + name.length, end);
  const declarations = (style?.value ?? "")
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && declaration.split(":")[0]!.trim().toLowerCase() !== "translate");
  const value = playableTranslateValue(translate);
  if (value) declarations.push(`translate: ${value}`);
  const text = declarations.join("; ");
  if (style) {
    // Without declarations the attribute goes, with the space before it.
    if (!text) return `${html.slice(0, style.spaceStart)}${html.slice(style.end)}`;
    const quote = style.quote ?? "\"";
    return `${html.slice(0, style.start)}style=${quote}${text}${quote}${html.slice(style.end)}`;
  }
  if (!text) return html;
  const afterName = start + 1 + name.length;
  return `${html.slice(0, afterName)} style="${text}"${html.slice(afterName)}`;
}

interface StyleAttribute {
  /** Where the whitespace before the attribute starts. */
  spaceStart: number;
  /** Where the attribute name starts. */
  start: number;
  /** Just past the attribute, after its closing quote. */
  end: number;
  value: string;
  quote?: "\"" | "'";
}

/** Scans the attributes of a start tag between `from` and its end for `style`. */
function findStyleAttribute(html: string, from: number, end: number): StyleAttribute | undefined {
  let index = from;
  while (index < end) {
    const spaceStart = index;
    while (index < end && /[\s/]/.test(html[index]!)) index += 1;
    if (index >= end || html[index] === ">") return undefined;
    const start = index;
    while (index < end && !/[\s=/>]/.test(html[index]!)) index += 1;
    const name = html.slice(start, index).toLowerCase();
    const nameEnd = index;
    while (index < end && /\s/.test(html[index]!)) index += 1;
    if (html[index] !== "=") {
      if (name === "style") return { spaceStart, start, end: nameEnd, value: "" };
      continue;
    }
    index += 1;
    while (index < end && /\s/.test(html[index]!)) index += 1;
    const quote = html[index] === "\"" || html[index] === "'" ? html[index] as "\"" | "'" : undefined;
    let valueStart: number;
    let valueEnd: number;
    if (quote) {
      valueStart = index + 1;
      valueEnd = html.indexOf(quote, valueStart);
      if (valueEnd < 0 || valueEnd >= end) return undefined;
      index = valueEnd + 1;
    } else {
      valueStart = index;
      while (index < end && !/[\s>]/.test(html[index]!)) index += 1;
      valueEnd = index;
    }
    if (name === "style") {
      return { spaceStart, start, end: index, value: html.slice(valueStart, valueEnd), ...(quote ? { quote } : {}) };
    }
  }
  return undefined;
}
