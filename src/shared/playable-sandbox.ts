import type { CompiledPlayableSurface } from "./playable-compiled.js";
import type { PlayableCleanup, PlayableNodeContext } from "./playable-nodes.js";
import {
  describePlayablePick,
  type PlayablePickResult,
} from "./playable-picker.js";
import {
  parsePlayableTranslate,
  playableTranslateValue,
  roundOffset,
  type PlayableTranslate,
} from "./playable-move.js";
import type { PlayableMove, PlayablePreviewTool, PlayableTextEdit } from "./playable-player-protocol.js";
import { PLAYABLE_SOURCE_ATTRIBUTE } from "./playable-source-locations.js";
import type {
  PlayableMountedSurface,
  PlayableSurfaceHost,
} from "./playable-runtime.js";

export const PLAYABLE_SANDBOX_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; script-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const PLAYABLE_IFRAME_SANDBOX = "allow-scripts";

export interface PlayableSurfaceModule {
  mount(context: PlayableNodeContext): unknown;
}

export type PlayableModuleLoader = (javascript: string) => Promise<unknown>;

export class DocumentPlayableSurfaceHost implements PlayableSurfaceHost {
  readonly #document: Document;
  readonly #loadModule: PlayableModuleLoader;
  readonly #projectRoot: HTMLElement;
  readonly #nodeLayer: HTMLElement;
  #picking?: { stop: () => void };

  constructor(
    document: Document,
    loadModule: PlayableModuleLoader = loadPlayableModule,
  ) {
    this.#document = document;
    this.#loadModule = loadModule;
    assertPlayableSandboxDocument(document);
    installPlayableSandboxCsp(document);
    const scaffold = createSandboxScaffold(document);
    this.#projectRoot = scaffold.projectRoot;
    this.#nodeLayer = scaffold.nodeLayer;
  }

  mountNode(
    surface: CompiledPlayableSurface,
    context: Omit<PlayableNodeContext, "root">,
  ): Promise<PlayableMountedSurface> {
    return this.#mount(this.#nodeLayer, surface, context);
  }

  destroy(): void {
    this.stopPicking();
    this.#projectRoot.remove();
  }

  /**
   * Hands the preview's input to an authoring tool until it is stopped. The
   * element under the pointer is outlined and surfaces receive no pointer or
   * keyboard input. With `select`, each click reports an element; holding
   * Shift, Command, or Control adds it to the selection. With `text`, a click
   * makes an element's text editable in place; Enter or leaving the element
   * reports the edit and Escape reverts it. With `move`, dragging an element
   * moves it and reports where it ended up; Escape during a drag puts it
   * back. Escape otherwise cancels the tool.
   */
  startPicking(
    tool: PlayablePreviewTool,
    handlers: {
      onPick: (result: PlayablePickResult, additive: boolean) => void;
      onTextEdit: (edit: PlayableTextEdit) => void;
      onMove: (move: PlayableMove) => void;
      onCancel: () => void;
    },
  ): void {
    this.stopPicking();
    const view = this.#document.defaultView!;
    const outline = this.#document.createElement("div");
    outline.dataset.playablePickOutline = "true";
    Object.assign(outline.style, {
      position: "absolute",
      zIndex: "2",
      pointerEvents: "none",
      boxSizing: "border-box",
      border: "2px solid #4f8cff",
      background: tool === "text" ? "transparent" : "rgba(79, 140, 255, 0.12)",
      display: "none",
    });
    this.#projectRoot.append(outline);
    const previousCursor = this.#projectRoot.style.cursor;
    const idleCursor = tool === "text" ? "text" : tool === "move" ? "grab" : "crosshair";
    this.#projectRoot.style.cursor = idleCursor;
    let editing: TextEditing | undefined;
    let dragging: Dragging | undefined;

    const inside = (event: Event) => Boolean(editing && event.composedPath().includes(editing.element));
    const block = (event: Event) => {
      // Input to the element being edited keeps its default action, such as
      // typing, but still never reaches the surface's own listeners.
      if (!inside(event)) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const place = (box: PlayablePickResult["box"] | undefined) => {
      if (!box) {
        outline.style.display = "none";
        return;
      }
      const root = this.#projectRoot.getBoundingClientRect();
      Object.assign(outline.style, {
        display: "block",
        left: `${box.x - root.x}px`,
        top: `${box.y - root.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    };
    const hover = (event: Event) => {
      block(event);
      if (editing) return;
      if (dragging) return drag(event as PointerEvent);
      if (tool === "move") return place(movableTarget(event.composedPath())?.pick.box);
      const pick = describePlayablePick(event.composedPath());
      const target = event.composedPath()[0];
      place(pick && (tool === "select" || isTextTarget(target)) ? pick.box : undefined);
    };
    const finish = (commit: boolean) => {
      const current = editing;
      if (!current) return;
      editing = undefined;
      const { element, pick, before, inPlace } = current;
      element.removeEventListener("blur", current.onBlur);
      element.removeAttribute("contenteditable");
      const after = (element.textContent ?? "").trim();
      const changed = commit && after && after !== before.trim();
      // Text the Agent will change goes back to what the source says until it does.
      if (!changed || !inPlace) element.textContent = current.original;
      place(undefined);
      if (changed) handlers.onTextEdit({ pick, before, after, inPlace });
    };
    const press = (event: Event) => {
      block(event);
      const pointer = event as PointerEvent;
      if (tool !== "move" || dragging || pointer.button !== 0) return;
      const target = movableTarget(event.composedPath());
      const root = target?.element.getRootNode();
      const size = root instanceof ShadowRoot ? root.host.getBoundingClientRect() : undefined;
      if (!target || !size?.width || !size.height) return;
      const { element } = target;
      const original = { translate: element.style.translate, transition: element.style.transition };
      const base = parsePlayableTranslate(original.translate, size);
      dragging = {
        ...target,
        pointerId: pointer.pointerId,
        start: { x: pointer.clientX, y: pointer.clientY },
        delta: { x: 0, y: 0 },
        size: { width: size.width, height: size.height },
        base: base ?? { x: 0, y: 0 },
        original,
        inPlace: base !== undefined && element.hasAttribute(PLAYABLE_SOURCE_ATTRIBUTE),
      };
      // A transition on the element would make it trail the pointer.
      element.style.transition = "none";
      element.setPointerCapture(pointer.pointerId);
      this.#projectRoot.style.cursor = "grabbing";
    };
    const drag = (pointer: PointerEvent) => {
      const current = dragging;
      if (!current || pointer.pointerId !== current.pointerId) return;
      const delta = { x: pointer.clientX - current.start.x, y: pointer.clientY - current.start.y };
      current.delta = delta;
      current.element.style.translate = `calc(${current.base.x}cqw + ${delta.x}px) calc(${current.base.y}cqh + ${delta.y}px)`;
      place({ ...current.pick.box, x: current.pick.box.x + delta.x, y: current.pick.box.y + delta.y });
    };
    const endDrag = (commit: boolean) => {
      const current = dragging;
      if (!current) return;
      dragging = undefined;
      const { element, delta, size, base, original } = current;
      if (element.hasPointerCapture(current.pointerId)) element.releasePointerCapture(current.pointerId);
      this.#projectRoot.style.cursor = idleCursor;
      const moved = commit && Math.hypot(delta.x, delta.y) >= MOVE_THRESHOLD;
      const translate = {
        x: roundOffset(base.x + (delta.x / size.width) * 100),
        y: roundOffset(base.y + (delta.y / size.height) * 100),
      };
      const inPlace = current.inPlace && !overridesTranslate(element);
      // The source will say the same once the preview reloads; a move the Agent makes goes back until it does.
      element.style.translate = moved && inPlace ? playableTranslateValue(translate) ?? "" : original.translate;
      element.style.transition = original.transition;
      place(undefined);
      if (moved) handlers.onMove({ pick: current.pick, translate, inPlace });
    };
    const release = (event: Event) => {
      block(event);
      if ((event as PointerEvent).pointerId === dragging?.pointerId) endDrag(event.type === "pointerup");
    };
    const click = (event: Event) => {
      block(event);
      if (tool === "move") return;
      if (inside(event)) return;
      finish(true);
      const pick = describePlayablePick(event.composedPath());
      if (!pick) return;
      if (tool === "select") {
        const mouse = event as MouseEvent;
        handlers.onPick(pick, mouse.shiftKey || mouse.metaKey || mouse.ctrlKey);
        return;
      }
      const target = event.composedPath()[0];
      if (!isTextTarget(target)) return;
      const element = target as HTMLElement;
      const original = element.textContent ?? "";
      const onBlur = () => finish(true);
      editing = { element, pick, original, before: original.replace(/\s+/g, " ").trim(), inPlace: holdsSourceText(element), onBlur };
      element.setAttribute("contenteditable", "plaintext-only");
      element.addEventListener("blur", onBlur);
      element.focus();
      view.getSelection()?.selectAllChildren(element);
      place(pick.box);
    };
    const key = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      if (editing) {
        block(event);
        if (keyboard.key === "Enter" && !keyboard.shiftKey) {
          keyboard.preventDefault();
          finish(true);
        } else if (keyboard.key === "Escape") {
          keyboard.preventDefault();
          finish(false);
        }
        return;
      }
      block(event);
      if (keyboard.key !== "Escape") return;
      if (dragging) return endDrag(false);
      this.stopPicking();
      handlers.onCancel();
    };
    const listeners: Array<[string, (event: Event) => void]> = [
      ["pointermove", hover],
      ["pointerover", hover],
      ["pointerdown", press],
      ["pointerup", release],
      ["pointercancel", release],
      ["click", click],
      ["keydown", key],
      ...BLOCKED_PICK_EVENTS.map((type) => [type, block] as [string, (event: Event) => void]),
    ];
    for (const [type, listener] of listeners)
      view.addEventListener(type, listener, { capture: true });
    this.#picking = {
      stop: () => {
        finish(true);
        endDrag(false);
        for (const [type, listener] of listeners)
          view.removeEventListener(type, listener, { capture: true });
        outline.remove();
        this.#projectRoot.style.cursor = previousCursor;
      },
    };
  }

  stopPicking(): void {
    const picking = this.#picking;
    this.#picking = undefined;
    picking?.stop();
  }

  async #mount(
    layer: HTMLElement,
    surface: CompiledPlayableSurface,
    context: Omit<PlayableNodeContext, "root">,
  ): Promise<PlayableMountedSurface> {
    const host = this.#document.createElement("div");
    host.dataset.playableSurface = surface.id;
    host.style.width = "100%";
    host.style.height = "100%";
    const root = host.attachShadow({ mode: "open" });
    const style = this.#document.createElement("style");
    style.textContent = surface.css;
    const template = this.#document.createElement("template");
    template.innerHTML = surface.html;
    root.append(style, template.content.cloneNode(true));
    layer.append(host);

    try {
      const module = await this.#loadModule(surface.javascript);
      if (!isPlayableSurfaceModule(module))
        throw new Error(
          `Playable surface "${surface.id}" does not export a mount function.`,
        );
      const cleanup = await module.mount({ ...context, root });
      return {
        cleanup: cleanup as PlayableCleanup | undefined,
        destroy: () => host.remove(),
      };
    } catch (cause) {
      host.remove();
      throw cause;
    }
  }
}

export function assertPlayableSandboxDocument(document: Document): void {
  const view = document.defaultView;
  if (!view || view === view.top || view.origin !== "null") {
    throw new Error(
      'Playable surfaces require an opaque-origin iframe with sandbox="allow-scripts".',
    );
  }
}

export function installPlayableSandboxCsp(document: Document): void {
  const existing = document.head.querySelector<HTMLMetaElement>(
    'meta[data-playable-sandbox-csp="true"]',
  );
  if (existing) {
    if (existing.content !== PLAYABLE_SANDBOX_CSP)
      throw new Error(
        "Playable sandbox CSP does not match the Runtime policy.",
      );
    return;
  }

  const meta = document.createElement("meta");
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = PLAYABLE_SANDBOX_CSP;
  meta.dataset.playableSandboxCsp = "true";
  document.head.prepend(meta);
}

export async function loadPlayableModule(javascript: string): Promise<unknown> {
  const url = URL.createObjectURL(
    new Blob([javascript], { type: "text/javascript" }),
  );
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createSandboxScaffold(document: Document): {
  projectRoot: HTMLElement;
  nodeLayer: HTMLElement;
} {
  document.documentElement.style.width = "100%";
  document.documentElement.style.height = "100%";
  document.body.replaceChildren();
  document.body.style.width = "100%";
  document.body.style.height = "100%";
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  const projectRoot = document.createElement("main");
  projectRoot.dataset.playableSandbox = "true";
  projectRoot.style.position = "relative";
  projectRoot.style.width = "100%";
  projectRoot.style.height = "100%";
  projectRoot.style.overflow = "hidden";

  const nodeLayer = document.createElement("div");
  nodeLayer.dataset.playableNodeLayer = "true";
  setLayerStyle(nodeLayer, 0);

  projectRoot.append(nodeLayer);
  document.body.append(projectRoot);
  return { projectRoot, nodeLayer };
}

interface TextEditing {
  element: HTMLElement;
  pick: PlayablePickResult;
  /** The text before editing, restored on Escape. */
  original: string;
  before: string;
  inPlace: boolean;
  onBlur: () => void;
}

interface Dragging {
  element: HTMLElement;
  /** The element before the drag started. */
  pick: PlayablePickResult;
  pointerId: number;
  start: { x: number; y: number };
  /** How far the pointer has moved, in the frame's CSS pixels. */
  delta: { x: number; y: number };
  /** The surface's size, which cqw and cqh are hundredths of. */
  size: { width: number; height: number };
  /** The offset the element had, in cqw and cqh. */
  base: PlayableTranslate;
  /** The inline values the drag replaces, restored when it is cancelled. */
  original: { translate: string; transition: string };
  inPlace: boolean;
}

/** Pointer travel, in CSS pixels, before a press becomes a move instead of a click. */
const MOVE_THRESHOLD = 3;

/**
 * The element a drag at the start of `path` moves, with its pick. Inline
 * boxes ignore `translate`, so a press on one moves the box that holds it.
 * A surface's own root and its background stay put.
 */
function movableTarget(path: readonly EventTarget[]): { element: HTMLElement; pick: PlayablePickResult } | undefined {
  let element = path[0] instanceof HTMLElement ? path[0] : undefined;
  while (element && ["inline", "contents"].includes(getComputedStyle(element).display)) element = element.parentElement ?? undefined;
  if (!element?.parentElement || element.getAttribute("data-media") === "backdrop") return undefined;
  const pick = describePlayablePick(path.slice(path.indexOf(element)));
  return pick ? { element, pick } : undefined;
}

/**
 * An animation on the element sets `translate` in place of the element's
 * own, so an offset written to its style would not show. Animations that add
 * to it, like the Project Style's `.rise`, are fine, and transitions end.
 */
function overridesTranslate(element: Element): boolean {
  return element.getAnimations().some((animation) => {
    const effect = animation.effect;
    if ("transitionProperty" in animation || !(effect instanceof KeyframeEffect) || effect.composite !== "replace") return false;
    return effect.getKeyframes().some((frame) => "translate" in frame);
  });
}

/**
 * Elements whose text can be typed over: they hold text of their own and are
 * not form fields. A container whose text all sits in child elements is not
 * one; typing over it would replace the whole layout.
 */
function isTextTarget(target: unknown): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  if (["input", "textarea", "select", "img", "video", "audio", "canvas", "svg", "iframe"].includes(tag)) return false;
  return Array.from(target.childNodes).some((child) => child.nodeType === 3 && Boolean(child.textContent?.trim()));
}

/**
 * The element came from surface HTML and holds only text, so its source can
 * be rewritten directly.
 */
function holdsSourceText(element: Element): boolean {
  return element.hasAttribute(PLAYABLE_SOURCE_ATTRIBUTE)
    && Array.from(element.childNodes).every((child) => child.nodeType === 3 || child.nodeType === 8);
}

const BLOCKED_PICK_EVENTS = [
  "mousedown",
  "mouseup",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
  "keyup",
  "keypress",
];

function setLayerStyle(layer: HTMLElement, zIndex: number): void {
  layer.style.position = "absolute";
  layer.style.inset = "0";
  layer.style.zIndex = String(zIndex);
}

function isPlayableSurfaceModule(
  value: unknown,
): value is PlayableSurfaceModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "mount") === "function"
  );
}
