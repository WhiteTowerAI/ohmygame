import type { PlayableAssetType } from "./playable-nodes.js";
import { scanPlayableStartTags } from "./playable-source-locations.js";
import { parsePlayableVideoClip, type PlayableVideoClip } from "./playable-video-clip.js";

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
    if (["data-asset", "data-type", "data-clip-start", "data-clip-end"].includes(attribute.name)) {
      text = text.slice(0, attribute.start) + text.slice(attribute.end);
    }
  }
  return text;
}

export interface PlayableBackdropDetails {
  assetId: string;
  type: string;
  clip?: PlayableVideoClip;
}

/** The single background's source and authored range, without editor annotations. */
export function playableBackdropDetails(html: string): PlayableBackdropDetails | undefined {
  const tag = backdropTag(html);
  if (!tag) return undefined;
  const value = (name: string) => tag.attributes.find((attribute) => attribute.name === name)?.value;
  const assetId = value("data-asset");
  if (!assetId) return undefined;
  return { assetId, type: value("data-type") ?? "image", clip: parsePlayableVideoClip(value("data-clip-start"), value("data-clip-end")) };
}

/** Returns a build diagnostic only for backgrounds that opt into trimming. */
export function playableBackdropClipError(html: string): string | undefined {
  let clipped = 0;
  for (const tag of scanPlayableStartTags(html)) {
    const text = html.slice(tag.nameEnd, tag.end - (html.slice(tag.start, tag.end).endsWith("/>") ? 2 : 1));
    const attributes = [...text.matchAll(ATTRIBUTE)].map((match) => ({ name: match[1]!.toLowerCase(), value: match[2] ?? match[3] ?? match[4] }));
    if (!attributes.some((attribute) => attribute.name === "data-clip-start" || attribute.name === "data-clip-end")) continue;
    clipped += 1;
    const value = (name: string) => attributes.find((attribute) => attribute.name === name)?.value;
    if (value("data-media") !== "backdrop" || value("data-type") !== "video" || !value("data-asset")) return "Video clip attributes require a declared video background.";
    if (["data-clip-start", "data-clip-end"].some((name) => attributes.filter((attribute) => attribute.name === name).length > 1)) return "Video clip attributes must not be duplicated.";
    try {
      parsePlayableVideoClip(
        attributes.some((attribute) => attribute.name === "data-clip-start") ? value("data-clip-start") ?? "" : undefined,
        attributes.some((attribute) => attribute.name === "data-clip-end") ? value("data-clip-end") ?? "" : undefined,
      );
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  }
  if (clipped && !backdropTag(html)) return "Video trimming requires exactly one background.";
  return undefined;
}

/** Edits only the clip attributes, refusing a background/range changed since opening. */
export function setPlayableBackdropClip(html: string, expected: PlayableBackdropDetails, clip?: PlayableVideoClip): string | undefined {
  const current = playableBackdropDetails(html);
  if (!current || current.type !== "video" || JSON.stringify(current) !== JSON.stringify(expected)) return undefined;
  if (clip) parsePlayableVideoClip(String(clip.start), clip.end === undefined ? undefined : String(clip.end));
  const tag = backdropTag(html)!;
  let opening = tag.text;
  for (const attribute of [...tag.attributes].reverse()) {
    if (attribute.name === "data-clip-start" || attribute.name === "data-clip-end") opening = opening.slice(0, attribute.start) + opening.slice(attribute.end);
  }
  const close = opening.endsWith("/>") ? "/>" : ">";
  const attributes = clip ? `${clip.start ? ` data-clip-start="${clip.start}"` : ""}${clip.end === undefined ? "" : ` data-clip-end="${clip.end}"`}` : "";
  if (attributes) opening = opening.slice(0, -close.length).trimEnd() + attributes + close;
  return html.slice(0, tag.index) + opening + html.slice(tag.index + tag.text.length);
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
