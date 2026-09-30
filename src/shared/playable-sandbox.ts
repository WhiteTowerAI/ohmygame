import type { CompiledPlayableSurface } from "./playable-compiled.js";
import type { PlayableCleanup, PlayableNodeContext } from "./playable-nodes.js";
import {
  describePlayablePick,
  type PlayablePickResult,
} from "./playable-picker.js";
import type { PlayablePreviewTool, PlayableTextEdit } from "./playable-player-protocol.js";
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
   * reports the edit and Escape reverts it. Escape outside an edit cancels
   * the tool.
   */
  startPicking(
    tool: PlayablePreviewTool,
    handlers: {
      onPick: (result: PlayablePickResult, additive: boolean) => void;
      onTextEdit: (edit: PlayableTextEdit) => void;
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
    this.#projectRoot.style.cursor = tool === "text" ? "text" : "crosshair";
    let editing: TextEditing | undefined;

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
    const click = (event: Event) => {
      block(event);
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
      this.stopPicking();
      handlers.onCancel();
    };
    const listeners: Array<[string, (event: Event) => void]> = [
      ["pointermove", hover],
      ["pointerover", hover],
      ["click", click],
      ["keydown", key],
      ...BLOCKED_PICK_EVENTS.map((type) => [type, block] as [string, (event: Event) => void]),
    ];
    for (const [type, listener] of listeners)
      view.addEventListener(type, listener, { capture: true });
    this.#picking = {
      stop: () => {
        finish(true);
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
  "pointerdown",
  "pointerup",
  "pointercancel",
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
