import type { CompiledPlayableSurface } from "./playable-compiled.js";
import type { PlayableCleanup, PlayableNodeContext } from "./playable-nodes.js";
import {
  describePlayablePick,
  type PlayablePickResult,
} from "./playable-picker.js";
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
   * Enters pick mode: outlines the element under the pointer and blocks all
   * pointer and keyboard input to surfaces. A click reports the element and
   * leaves pick mode; Escape cancels.
   */
  startPicking(
    onPick: (result: PlayablePickResult) => void,
    onCancel: () => void,
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
      background: "rgba(79, 140, 255, 0.12)",
      display: "none",
    });
    this.#projectRoot.append(outline);
    const previousCursor = this.#projectRoot.style.cursor;
    this.#projectRoot.style.cursor = "crosshair";

    const block = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const hover = (event: Event) => {
      block(event);
      const pick = describePlayablePick(event.composedPath());
      if (!pick) {
        outline.style.display = "none";
        return;
      }
      const root = this.#projectRoot.getBoundingClientRect();
      Object.assign(outline.style, {
        display: "block",
        left: `${pick.box.x - root.x}px`,
        top: `${pick.box.y - root.y}px`,
        width: `${pick.box.width}px`,
        height: `${pick.box.height}px`,
      });
    };
    const click = (event: Event) => {
      block(event);
      const pick = describePlayablePick(event.composedPath());
      if (!pick) return;
      this.stopPicking();
      onPick(pick);
    };
    const key = (event: Event) => {
      block(event);
      if ((event as KeyboardEvent).key !== "Escape") return;
      this.stopPicking();
      onCancel();
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
