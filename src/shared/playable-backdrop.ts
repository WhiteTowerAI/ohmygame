import { scanPlayableStartTags } from "./playable-start-tags.js";
import { parsePlayableVideoClip } from "./playable-video-clip.js";

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
