import { PLAYABLE_SOURCE_ATTRIBUTE } from "./playable-source-locations.js";

export interface PlayablePickResult {
  /** Node ID, or `"shell"` when the element belongs to the Shell. */
  nodeId: string;
  /** `<file>:<line>:<column>` from a preview build, when the element came from surface HTML. */
  source?: string;
  /** CSS path from the surface's shadow root to the element. */
  cssPath: string;
  tag: string;
  text: string;
  /** Bounding box in the sandbox frame's CSS pixels. */
  box: { x: number; y: number; width: number; height: number };
}

const TEXT_EXCERPT_LIMIT = 120;
const SURFACE_ATTRIBUTE = "data-playable-surface";

/** The subset of Element used by the picker, so path logic runs without a DOM. */
export interface PickableElement {
  readonly tagName: string;
  readonly id: string;
  readonly parentElement: PickableElement | null;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

/**
 * Builds the pick result for the element at the start of an event's composed
 * path. Script-created elements have no source attribute, so the nearest
 * annotated ancestor supplies the source location. Returns undefined when the
 * path does not lead into a Playable surface.
 */
export function describePlayablePick(
  composedPath: readonly unknown[],
): PlayablePickResult | undefined {
  const elements = composedPath.filter(isPickableElement);
  const target = elements[0];
  if (!target) return undefined;
  const surface = elements.find(
    (element) => element.getAttribute(SURFACE_ATTRIBUTE) !== null,
  );
  if (!surface || surface === target) return undefined;
  const surfaceIndex = elements.indexOf(surface);
  const inside = elements.slice(0, surfaceIndex);
  const source = inside
    .map((element) => element.getAttribute(PLAYABLE_SOURCE_ATTRIBUTE))
    .find((value): value is string => value !== null);
  const rect = target.getBoundingClientRect();
  return {
    nodeId: surface.getAttribute(SURFACE_ATTRIBUTE)!,
    ...(source ? { source } : {}),
    cssPath: playableCssPath(target),
    tag: target.tagName.toLowerCase(),
    text: excerpt(target.textContent ?? ""),
    box: {
      x: round(rect.x),
      y: round(rect.y),
      width: round(rect.width),
      height: round(rect.height),
    },
  };
}

/**
 * CSS path from the surface root: stops at an element with an ID or at the
 * surface host, and uses `:nth-of-type` where siblings share a tag.
 */
export function playableCssPath(element: PickableElement): string {
  const segments: string[] = [];
  let current: PickableElement | null = element;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (current.id && /^[A-Za-z][\w-]*$/.test(current.id)) {
      segments.unshift(`${tag}#${current.id}`);
      break;
    }
    const host: PickableElement | null = current.parentElement;
    const parent: PickableElement | null =
      host && host.getAttribute(SURFACE_ATTRIBUTE) === null ? host : null;
    const siblings = parent ? childElements(parent) : [];
    const sameTag = siblings.filter(
      (sibling) => sibling.tagName === current!.tagName,
    );
    segments.unshift(
      sameTag.length > 1
        ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})`
        : tag,
    );
    current = parent;
  }
  return segments.join(" > ");
}

function childElements(parent: PickableElement): PickableElement[] {
  const children = Reflect.get(parent, "children") as
    | ArrayLike<PickableElement>
    | undefined;
  return children ? Array.from(children) : [];
}

function isPickableElement(value: unknown): value is PickableElement {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "tagName") === "string" &&
    typeof Reflect.get(value, "getAttribute") === "function" &&
    typeof Reflect.get(value, "getBoundingClientRect") === "function"
  );
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > TEXT_EXCERPT_LIMIT
    ? `${normalized.slice(0, TEXT_EXCERPT_LIMIT - 1)}…`
    : normalized;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
