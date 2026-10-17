import type { CompiledPlayableSurface } from "./playable-compiled.js";
import type { PlayableCleanup, PlayableNodeContext } from "./playable-nodes.js";
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

/**
 * A story played as an ordinary web page rather than in the sandbox: each
 * surface's `html`, `css`, and `javascript` are paths of the Node's files,
 * which the page loads from `base` as they are. Its own modules and
 * stylesheets resolve like any page's.
 */
export interface PlayablePageSurfaces {
  base: URL;
}

export class DocumentPlayableSurfaceHost implements PlayableSurfaceHost {
  readonly #document: Document;
  readonly #loadModule: PlayableModuleLoader;
  readonly #projectRoot: HTMLElement;
  readonly #nodeLayer: HTMLElement;
  #watchingMedia?: () => void;
  readonly #watchSurface?: (root: ShadowRoot) => () => void;
  readonly #page?: PlayablePageSurfaces;
  #mounts = 0;

  /**
   * `watchSurface` is called with each surface as it mounts, before its code
   * runs, and the function it returns when the surface goes; the sandbox's
   * audio uses it to hear the surface's media.
   */
  constructor(
    document: Document,
    loadModule: PlayableModuleLoader = loadPlayableModule,
    watchSurface?: (root: ShadowRoot) => () => void,
    page?: PlayablePageSurfaces,
  ) {
    this.#document = document;
    this.#loadModule = loadModule;
    this.#watchSurface = watchSurface;
    this.#page = page;
    if (!page) {
      assertPlayableSandboxDocument(document);
      installPlayableSandboxCsp(document);
    }
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

  /** The stage every surface mounts in; authoring tools work over it. */
  get projectRoot(): HTMLElement {
    return this.#projectRoot;
  }

  destroy(): void {
    this.#watchingMedia?.();
    this.#watchingMedia = undefined;
    this.#projectRoot.remove();
  }

  /** Watches the mounted Node's background video; see `watchPlayableBackdropVideo`. */
  watchBackdropVideo(onChange: (video: HTMLVideoElement | undefined) => void): () => void {
    this.#watchingMedia?.();
    const stopWatching = watchPlayableBackdropVideo(this.#nodeLayer, onChange);
    const stop = () => {
      stopWatching();
      if (this.#watchingMedia === stop) this.#watchingMedia = undefined;
    };
    this.#watchingMedia = stop;
    return stop;
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
    const template = this.#document.createElement("template");
    let stylesheet: Promise<unknown> | undefined;
    if (this.#page) {
      // A page loads the Node's own files; its stylesheet's imports resolve from where it is.
      const response = await fetch(new URL(surface.html, this.#page.base));
      if (!response.ok) throw new Error(`Could not load ${surface.html} (${response.status}).`);
      template.innerHTML = await response.text();
      const link = this.#document.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL(surface.css, this.#page.base).href;
      stylesheet = new Promise((resolve) => {
        link.onload = resolve;
        link.onerror = resolve;
      });
      root.append(link, template.content.cloneNode(true));
    } else {
      const style = this.#document.createElement("style");
      style.textContent = surface.css;
      template.innerHTML = surface.html;
      root.append(style, template.content.cloneNode(true));
    }
    layer.append(host);
    const unwatch = this.#watchSurface?.(root);
    const remove = () => {
      host.remove();
      unwatch?.();
    };

    try {
      // Each mount gets the Node's module afresh, as the sandbox does.
      const module = this.#page
        ? await import(/* @vite-ignore */ `${new URL(surface.javascript, this.#page.base).href}?mount=${++this.#mounts}`)
        : await this.#loadModule(surface.javascript);
      await stylesheet;
      if (!isPlayableSurfaceModule(module))
        throw new Error(
          `Playable surface "${surface.id}" does not export a mount function.`,
        );
      const cleanup = await module.mount({ ...context, root });
      return {
        cleanup: cleanup as PlayableCleanup | undefined,
        destroy: remove,
      };
    } catch (cause) {
      remove();
      throw cause;
    }
  }
}

/**
 * Calls `onChange` with the background video (`[data-media="backdrop"] video`)
 * of the Node surfaces in `layer` whenever it appears, changes, or goes, until
 * the returned function is called. Node code creates the video, so it is
 * looked for again whenever a surface's content changes.
 */
export function watchPlayableBackdropVideo(
  layer: HTMLElement,
  onChange: (video: HTMLVideoElement | undefined) => void,
): () => void {
  const view = layer.ownerDocument.defaultView!;
  let current: HTMLVideoElement | undefined;
  const find = () => {
    for (const host of layer.children) {
      const video = host.shadowRoot?.querySelector('[data-media="backdrop"] video');
      if (video) return video as HTMLVideoElement;
    }
    return undefined;
  };
  const update = () => {
    const next = find();
    if (next === current) return;
    current = next;
    onChange(next);
  };
  const surfaces = new view.MutationObserver(update);
  const observeSurfaces = () => {
    for (const host of layer.children) {
      if (host.shadowRoot) surfaces.observe(host.shadowRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-media"] });
    }
  };
  const surfaceList = new view.MutationObserver(() => {
    surfaces.disconnect();
    observeSurfaces();
    update();
  });
  surfaceList.observe(layer, { childList: true });
  observeSurfaces();
  update();
  return () => {
    surfaceList.disconnect();
    surfaces.disconnect();
  };
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
