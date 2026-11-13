import type { WebGamePreviewLayout } from "./web-game-player.js";

// The built-in browser: a project's tabs, shown in its Browser panel in the
// desktop app. Pages share one persistent session of their own, apart from the
// app and the game preview, so sign-ins last across projects and restarts.

/** One tab as the desktop app reports it. A tab without a URL shows the new-tab page. */
export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page's icon, as a URL the page itself gave. */
  favicon?: string;
  /** Why the page didn't load, when it didn't. */
  error?: string;
}

export interface BrowserState {
  projectId: string;
  tabs: BrowserTab[];
  active?: string;
}

/** What a tab keeps across restarts. */
export interface SavedBrowserTab {
  id: string;
  url: string;
  title: string;
}

/** A site the person visited in a project, for its new-tab page. */
export interface BrowserVisit {
  url: string;
  title: string;
  count: number;
  /** ISO time of the last visit. */
  last: string;
}

/** A project's browser, kept in the app's data, never in the project's folder. */
export interface ProjectBrowser {
  tabs: SavedBrowserTab[];
  active?: string;
  visits: BrowserVisit[];
}

export interface BrowserShortcut {
  title: string;
  url: string;
}

export const BROWSER_SEARCH_ENGINES = [
  "bing",
  "google",
  "baidu",
  "duckduckgo",
] as const;
export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];

/** The browser settings every project shares. */
export interface BrowserSettings {
  shortcuts: BrowserShortcut[];
  searchEngine: BrowserSearchEngine;
}

/** A shortcut a plugin adds to the new-tab page. */
export interface PluginBrowserShortcut extends BrowserShortcut {
  plugin: string;
  pluginTitle: string;
}

export const BROWSER_MAX_TABS = 20;
export const BROWSER_MAX_SHORTCUTS = 24;
export const BROWSER_MAX_VISITS = 200;
export const BROWSER_MAX_URL_LENGTH = 4_000;

const SEARCH_URLS: Record<BrowserSearchEngine, string> = {
  bing: "https://www.bing.com/search?q=",
  google: "https://www.google.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
  duckduckgo: "https://duckduckgo.com/?q=",
};

/** Whether the browser may open a URL: web pages only. */
export function isBrowserUrl(value: string): boolean {
  if (value.length > BROWSER_MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * What the address box opens for what was typed: a URL as it is, a host
 * (`example.com`, `localhost:5173`) over https, or http for a local one,
 * and anything else as a search.
 */
export function browserAddress(
  input: string,
  engine: BrowserSearchEngine,
): string {
  const text = input.trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text))
    return isBrowserUrl(text) ? new URL(text).href : searchUrl(text, engine);
  if (!/\s/.test(text)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(text);
    const host =
      /^([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text) ||
      /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/.test(text);
    if (local || host) {
      const url = `${local ? "http" : "https"}://${text}`;
      if (isBrowserUrl(url)) return new URL(url).href;
    }
  }
  return searchUrl(text, engine);
}

function searchUrl(text: string, engine: BrowserSearchEngine): string {
  return `${SEARCH_URLS[engine]}${encodeURIComponent(text)}`;
}

/** The desktop app's side of the Browser panel. */
export interface DesktopBrowserBridge {
  /** Shows a project's browser in the panel, opening its saved tabs the first time. */
  attach(
    projectId: string,
    attachment: string,
    layout: WebGamePreviewLayout,
    saved: ProjectBrowser,
    labels: BrowserMenuLabels,
  ): Promise<BrowserState>;
  /** The renderer has finished restoring tabs and is listening for changes. */
  ready(projectId: string, attachment: string): Promise<void>;
  layout(
    projectId: string,
    attachment: string,
    layout: WebGamePreviewLayout,
  ): Promise<void>;
  /** The panel is gone; the project's tabs close with it. */
  detach(projectId: string, attachment: string): Promise<void>;
  /** The active page's current frame as JPEG, to stand in while a menu covers it. */
  capture(projectId: string): Promise<Uint8Array>;
  /** Opens a tab, on the new-tab page without a URL; the new tab becomes the active one. */
  open(projectId: string, url?: string): Promise<BrowserState>;
  navigate(projectId: string, tabId: string, url: string): Promise<void>;
  select(projectId: string, tabId: string): Promise<void>;
  close(projectId: string, tabId: string): Promise<void>;
  back(projectId: string, tabId: string): Promise<void>;
  forward(projectId: string, tabId: string): Promise<void>;
  /** Reloads, or stops a page that is still loading. */
  reload(projectId: string, tabId: string, stop?: boolean): Promise<void>;
  onState(listener: (state: BrowserState) => void): () => void;
  /** The person pressed a browser shortcut while a page had focus. */
  onCommand(
    listener: (projectId: string, command: BrowserCommand) => void,
  ): () => void;
}

/** A page's context menu, in the app's language. */
export interface BrowserMenuLabels {
  openLinkInNewTab: string;
  copyLink: string;
  back: string;
  forward: string;
  reload: string;
  inspect: string;
}

export function isBrowserMenuLabels(
  value: unknown,
): value is BrowserMenuLabels {
  if (typeof value !== "object" || value === null) return false;
  const labels = value as Record<string, unknown>;
  return (
    [
      "openLinkInNewTab",
      "copyLink",
      "back",
      "forward",
      "reload",
      "inspect",
    ] as const
  ).every(
    (key) =>
      typeof labels[key] === "string" && (labels[key] as string).length <= 100,
  );
}

/** Shortcuts a page with focus hands to the panel. */
export type BrowserCommand = "focus-address" | "new-tab" | "reveal";
