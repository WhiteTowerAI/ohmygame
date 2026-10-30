import type { PlayableCleanup, PlayableNodeContext } from "./playable-nodes.js";
import { installPlayableVideoClips } from "./playable-video-clip.js";
import { waitForPlayableBackdrop } from "./playable-surface-ready.js";
import type {
  PlayableMountedSurface,
  PlayableSurface,
  PlayableSurfaceHost,
} from "./playable-runtime.js";

export interface PlayableSurfaceModule {
  mount(context: PlayableNodeContext): unknown;
}

/**
 * Where the story's page loads its Nodes from: each surface's `html`, `css`,
 * and `javascript` are paths of the Node's files, loaded from `base` as they
 * are, so its own modules and stylesheets resolve like any page's.
 */
export interface PlayablePageSurfaces {
  base: URL;
}

/** Mounts each Node of the story's page in a ShadowRoot of its own, over the page's stage. */
export class DocumentPlayableSurfaceHost implements PlayableSurfaceHost {
  readonly #document: Document;
  readonly #projectRoot: HTMLElement;
  readonly #nodeLayer: HTMLElement;
  #watchingMedia?: () => void;
  readonly #watchSurface?: (root: ShadowRoot) => () => void;
  readonly #page: PlayablePageSurfaces;
  #mounts = 0;

  /**
   * `watchSurface` is called with each surface as it mounts, before its code
   * runs, and the function it returns when the surface goes; the page's
   * audio uses it to hear the surface's media.
   */
  constructor(
    document: Document,
    page: PlayablePageSurfaces,
    watchSurface?: (root: ShadowRoot) => () => void,
    readonly onDiagnostic: (message: string) => void = () => {},
  ) {
    this.#document = document;
    this.#watchSurface = watchSurface;
    this.#page = page;
    const scaffold = createStage(document);
    this.#projectRoot = scaffold.projectRoot;
    this.#nodeLayer = scaffold.nodeLayer;
  }

  mountNode(
    surface: PlayableSurface,
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
    surface: PlayableSurface,
    context: Omit<PlayableNodeContext, "root">,
  ): Promise<PlayableMountedSurface> {
    const host = this.#document.createElement("div");
    host.dataset.playableSurface = surface.id;
    host.style.width = "100%";
    host.style.height = "100%";
    host.style.position = "absolute";
    host.style.inset = "0";
    // Opacity also hides descendants that explicitly set visibility: visible.
    host.style.opacity = "0";
    host.inert = true;
    const root = host.attachShadow({ mode: "open" });
    const template = this.#document.createElement("template");
    // The page loads the Node's own files; its stylesheet's imports resolve from where it is.
    const response = await fetch(new URL(surface.html, this.#page.base), { signal: context.lifecycle.signal });
    if (!response.ok) throw new Error(`Could not load ${surface.html} (${response.status}).`);
    template.innerHTML = await response.text();
    const link = this.#document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(surface.css, this.#page.base).href;
    const stylesheet = new Promise((resolve) => {
      link.onload = resolve;
      link.onerror = resolve;
    });
    root.append(link, template.content.cloneNode(true));
    layer.append(host);
    const stopClips = installPlayableVideoClips(root, this.onDiagnostic);
    context.lifecycle.signal.addEventListener("abort", stopClips, { once: true });
    const unwatch = this.#watchSurface?.(root);
    const remove = () => {
      stopClips();
      context.lifecycle.signal.removeEventListener("abort", stopClips);
      host.remove();
      unwatch?.();
    };

    try {
      // Each mount gets the Node's module afresh, so it starts from a clean state.
      const module = await import(/* @vite-ignore */ `${new URL(surface.javascript, this.#page.base).href}?mount=${++this.#mounts}`);
      await stylesheet;
      if (!isPlayableSurfaceModule(module))
        throw new Error(
          `Playable surface "${surface.id}" does not export a mount function.`,
        );
      const cleanup = await module.mount({ ...context, root });
      try {
        await waitForPlayableBackdrop(root, context.lifecycle.signal, this.onDiagnostic);
      } catch (cause) {
        if (typeof cleanup === "function") await cleanup();
        throw cause;
      }
      host.style.opacity = "1";
      const playing = [...root.querySelectorAll<HTMLMediaElement>("video, audio")].filter((media) => !media.paused);
      for (const media of playing) media.pause();
      return {
        activate: () => {
          host.inert = false;
          for (const media of playing) void media.play().catch(() => {});
        },
        deactivate: () => {
          host.inert = true;
          for (const media of root.querySelectorAll<HTMLMediaElement>("video, audio")) media.pause();
        },
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

/** The page's stage: the story takes the whole page, and Nodes mount in its layer. */
function createStage(document: Document): {
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
  // Page code may still find the stage by its earlier name.
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
