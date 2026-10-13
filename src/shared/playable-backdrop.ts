import type { PlayableAssetType } from "./playable-nodes.js";
import { scanPlayableStartTags } from "./playable-source-locations.js";

const ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
interface BackdropAttribute { name: string; value: string | undefined; start: number; end: number }
interface BackdropTag { index: number; text: string; attributes: BackdropAttribute[] }

/** The Node's one background tag, or undefined when there is none or more than one. */
function backdropTag(html: string): BackdropTag | undefined {
  let found: BackdropTag | undefined;
  for (const tag of scanPlayableStartTags(html)) {
    const text = html.slice(tag.start, tag.end);
    const offset = tag.nameEnd - tag.start;
    const attributes = [...text.slice(offset, text.endsWith("/>") ? -2 : -1).matchAll(ATTRIBUTE)].map((match) => ({
      name: match[1]!.toLowerCase(), value: match[2] ?? match[3] ?? match[4],
      start: offset + match.index, end: offset + match.index + match[0].length,
    }));
    if (!attributes.some((attribute) => attribute.name === "data-media" && attribute.value === "backdrop")) continue;
    if (found) return undefined;
    found = { index: tag.start, text, attributes };
  }
  return found;
}

/** Removes only actual Asset attributes and preserves all other source text. */
function withoutAssetAttributes(tag: BackdropTag): string {
  let text = tag.text;
  for (let index = tag.attributes.length - 1; index >= 0; index -= 1) {
    const attribute = tag.attributes[index]!;
    if (attribute.name === "data-asset" || attribute.name === "data-type") {
      text = text.slice(0, attribute.start) + text.slice(attribute.end);
    }
  }
  return text;
}

/**
 * Whether the Node has a background the editor can set, and whether it shows
 * anything yet; undefined when its HTML has no single `.backdrop`.
 */
export function playableBackdrop(html: string): "missing" | "set" | undefined {
  const tag = backdropTag(html);
  if (!tag) return undefined;
  return tag.attributes.some((attribute) => attribute.name === "data-asset" && attribute.value) ? "set" : "missing";
}

/**
 * Points the Node's background at another Asset by setting `data-asset` and
 * `data-type` on its `.backdrop`, which `showBackdrop()` in the Project Style
 * shows. Undefined when the HTML has no single background to set.
 */
export function setPlayableBackdrop(
  html: string,
  assetId: string,
  type: Extract<PlayableAssetType, "image" | "video">,
): string | undefined {
  const tag = backdropTag(html);
  if (!tag) return undefined;
  const bare = withoutAssetAttributes(tag);
  const close = bare.endsWith("/>") ? "/>" : ">";
  const opening = `${bare.slice(0, -close.length).trimEnd()} data-asset="${escapeAttribute(assetId)}" data-type="${type}"${close}`;
  return `${html.slice(0, tag.index)}${opening}${html.slice(tag.index + tag.text.length)}`;
}

/**
 * Takes the Asset off the Node's background by removing `data-asset` and
 * `data-type` from its `.backdrop`, which stays for the next one. Undefined
 * when the HTML has no single background.
 */
export function clearPlayableBackdrop(html: string): string | undefined {
  const tag = backdropTag(html);
  if (!tag) return undefined;
  return `${html.slice(0, tag.index)}${withoutAssetAttributes(tag)}${html.slice(tag.index + tag.text.length)}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
