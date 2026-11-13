import { randomUUID } from "node:crypto";
import {
  Menu,
  WebContentsView,
  clipboard,
  session,
  type BaseWindow,
  type BrowserWindow,
  type ContextMenuParams,
  type Input,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import {
  BROWSER_MAX_TABS,
  isBrowserUrl,
  type BrowserCommand,
  type BrowserMenuLabels,
  type BrowserState,
  type BrowserTab,
  type ProjectBrowser,
} from "../shared/browser.js";
import type { WebGamePreviewLayout } from "../shared/web-game-player.js";

/** Pages share this session, apart from the app's and the game preview's, and keep it across restarts. */
export const BROWSER_PARTITION = "persist:ohmygame-browser";

/** What a page may ask for without a prompt; everything else is refused. */
const ALLOWED_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
]);

interface Tab {
  id: string;
  /** Created when the tab first shows a page; a tab on the new-tab page has none. */
  view?: WebContentsView;
  /** The page to load once the tab is shown, or that last loaded. */
  url: string;
  title: string;
  favicon?: string;
  error?: string;
}

interface Editor extends WebGamePreviewLayout {
  id: string;
  window: BrowserWindow;
  ready?: boolean;
}

interface Project {
  selectionRevision: number;
  labels: BrowserMenuLabels;
  tabs: Tab[];
  popups: Set<BrowserWindow>;
  active?: string;
  editor?: Editor;
  parent?: BaseWindow;
  fullscreen?: boolean;
}

export interface BrowserViewsOptions {
  onState: (state: BrowserState) => void;
  onCommand: (projectId: string, command: BrowserCommand) => void;
  /** Opens a link a page wants in another app, such as mailto:. */
  openExternal: (url: string) => void;
  partition?: string;
}

/**
 * The Browser panel's pages, by project. Each tab is a native view placed
 * over the panel, as the game preview is; only the active tab shows.
 */
export class BrowserViews {
  readonly #projects = new Map<string, Project>();
  #session?: Session;

  constructor(private readonly options: BrowserViewsOptions) {}

  attached(projectId: string): boolean {
    const editor = this.#projects.get(projectId)?.editor;
    return !!editor?.ready && !editor.window.isDestroyed();
  }

  ready(projectId: string, attachment: string): void {
    const editor = this.#projects.get(projectId)?.editor;
    if (editor?.id === attachment) editor.ready = true;
  }

  /** The agent uses the person's tab, with the same page and sign-in session. */
  page(projectId: string, tabId: string): WebContents {
    const tab = this.#requireTab(this.#require(projectId), tabId);
    if (!tab.view || tab.view.webContents.isDestroyed()) throw new Error("This tab has no page");
    return tab.view.webContents;
  }

  pageVisible(projectId: string, tabId: string): boolean {
    const project = this.#projects.get(projectId);
    const tab = project?.tabs.find((entry) => entry.id === tabId);
    return project?.active === tabId && !!tab?.view?.getVisible();
  }

  /** Changes even when the person switches away and back between agent checks. */
  selectionRevision(projectId: string): number | undefined {
    return this.#projects.get(projectId)?.selectionRevision;
  }

  state(projectId: string): BrowserState {
    const project = this.#projects.get(projectId);
    return {
      projectId,
      tabs: project?.tabs.map((tab) => this.#tabState(tab)) ?? [],
      ...(project?.active ? { active: project.active } : {}),
    };
  }

  attach(
    projectId: string,
    attachment: string,
    window: BrowserWindow,
    layout: WebGamePreviewLayout,
    saved: ProjectBrowser,
    labels: BrowserMenuLabels,
  ): BrowserState {
    let project = this.#projects.get(projectId);
    if (!project) {
      const tabs = saved.tabs
        .filter((tab) => !tab.url || isBrowserUrl(tab.url))
        .slice(0, BROWSER_MAX_TABS)
        .map((tab): Tab => ({
          id: tab.id || randomUUID(),
          url: tab.url,
          title: tab.title,
        }));
      project = {
        selectionRevision: 0,
        labels,
        tabs,
        popups: new Set(),
        active: tabs.some((tab) => tab.id === saved.active)
          ? saved.active
          : tabs[0]?.id,
      };
      this.#projects.set(projectId, project);
    }
    project.labels = labels;
    project.editor = { ...layout, id: attachment, window };
    this.#show(projectId, project);
    return this.state(projectId);
  }

  layout(
    projectId: string,
    attachment: string,
    layout: WebGamePreviewLayout,
  ): void {
    const project = this.#projects.get(projectId);
    if (!project?.editor || project.editor.id !== attachment) return;
    Object.assign(project.editor, layout);
    this.#place(project);
  }

  detach(projectId: string, attachment: string): void {
    const project = this.#projects.get(projectId);
    if (!project?.editor || project.editor.id !== attachment) return;
    this.#projects.delete(projectId);
    for (const tab of project.tabs) this.#closeView(project, tab);
    for (const popup of project.popups)
      if (!popup.isDestroyed()) popup.destroy();
  }

  /** The owning renderer or window is gone, including reloads that skip React cleanup. */
  dispose(): void {
    for (const [id, project] of this.#projects) {
      if (project.editor) this.detach(id, project.editor.id);
    }
  }

  synchronize(): void {
    for (const project of this.#projects.values()) this.#place(project);
  }

  async capture(projectId: string): Promise<Uint8Array> {
    const view = this.#activeTab(this.#projects.get(projectId))?.view;
    if (!view || view.webContents.isDestroyed())
      throw new Error("No page is open.");
    return (await view.webContents.capturePage()).toJPEG(85);
  }

  open(projectId: string, url = ""): BrowserState {
    const project = this.#require(projectId);
    if (url && !isBrowserUrl(url))
      throw new Error("The browser opens web pages only.");
    if (project.tabs.length + project.popups.size >= BROWSER_MAX_TABS)
      throw new Error(`A project can have at most ${BROWSER_MAX_TABS} tabs.`);
    const tab: Tab = { id: randomUUID(), url, title: "" };
    project.tabs.push(tab);
    project.selectionRevision++;
    project.active = tab.id;
    this.#show(projectId, project);
    return this.state(projectId);
  }

  navigate(projectId: string, tabId: string, url: string): void {
    if (!isBrowserUrl(url))
      throw new Error("The browser opens web pages only.");
    const project = this.#require(projectId);
    const tab = this.#requireTab(project, tabId);
    tab.url = url;
    tab.error = undefined;
    if (tab.view) void tab.view.webContents.loadURL(url).catch(() => {});
    else if (project.active === tabId) this.#show(projectId, project);
    this.#publish(projectId);
  }

  select(projectId: string, tabId: string): void {
    const project = this.#require(projectId);
    this.#requireTab(project, tabId);
    if (project.active !== tabId) project.selectionRevision++;
    project.active = tabId;
    this.#show(projectId, project);
  }

  close(projectId: string, tabId: string): void {
    const project = this.#require(projectId);
    const index = project.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const [tab] = project.tabs.splice(index, 1);
    this.#closeView(project, tab!);
    if (project.active === tabId) {
      project.selectionRevision++;
      project.active = (project.tabs[index] ?? project.tabs[index - 1])?.id;
    }
    this.#show(projectId, project);
  }

  back(projectId: string, tabId: string): void {
    const history = this.#requireTab(this.#require(projectId), tabId).view
      ?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward(projectId: string, tabId: string): void {
    const history = this.#requireTab(this.#require(projectId), tabId).view
      ?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  reload(projectId: string, tabId: string, stop = false): void {
    const project = this.#require(projectId);
    const tab = this.#requireTab(project, tabId);
    if (!tab.view) return;
    if (stop) tab.view.webContents.stop();
    else {
      tab.error = undefined;
      tab.view.webContents.reload();
    }
  }

  #require(projectId: string): Project {
    const project = this.#projects.get(projectId);
    if (!project) throw new Error("The browser isn't open in this project.");
    return project;
  }

  #requireTab(project: Project, tabId: string): Tab {
    const tab = project.tabs.find((entry) => entry.id === tabId);
    if (!tab) throw new Error("That tab is closed.");
    return tab;
  }

  #activeTab(project: Project | undefined): Tab | undefined {
    return project?.tabs.find((tab) => tab.id === project.active);
  }

  /** Loads the active tab's page if it hasn't yet, and shows only it. */
  #show(projectId: string, project: Project): void {
    const active = this.#activeTab(project);
    if (active && !active.view && active.url)
      this.#createView(projectId, project, active);
    this.#place(project);
    this.#publish(projectId);
  }

  #browserSession(): Session {
    if (this.#session) return this.#session;
    const browser = session.fromPartition(
      this.options.partition ?? BROWSER_PARTITION,
    );
    // Sites that turn away embedded browsers see the Chrome it is.
    browser.setUserAgent(
      browser
        .getUserAgent()
        .replace(/\s(?:Electron|ohmygame|OhMyGame)\/\S+/g, ""),
    );
    browser.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    );
    browser.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission),
    );
    this.#session = browser;
    return browser;
  }

  #createView(projectId: string, project: Project, tab: Tab): void {
    const view = new WebContentsView({
      webPreferences: {
        session: this.#browserSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    tab.view = view;
    view.setBackgroundColor("#ffffff");
    const contents = view.webContents;
    const publish = () => {
      if (this.#projects.get(projectId) === project) this.#publish(projectId);
    };
    const openLink = (url: string) => {
      if (isBrowserUrl(url)) {
        if (
          this.#projects.get(projectId) === project &&
          project.tabs.length + project.popups.size < BROWSER_MAX_TABS
        )
          this.open(projectId, url);
      } else if (/^(mailto|tel):/i.test(url)) this.options.openExternal(url);
    };
    const guardNavigation = (page: WebContents) => {
      page.on("will-navigate", (event) => {
        if (isBrowserUrl(event.url)) return;
        event.preventDefault();
        if (/^(mailto|tel):/i.test(event.url))
          this.options.openExternal(event.url);
      });
      page.on("will-redirect", (event, url) => {
        if (!isBrowserUrl(url)) event.preventDefault();
      });
    };
    guardNavigation(contents);
    contents.setWindowOpenHandler((details) => {
      // Sign-in popups keep their opener, but share the same URL policy and view budget.
      if (
        details.disposition === "new-window" &&
        isBrowserUrl(details.url) &&
        project.tabs.length + project.popups.size < BROWSER_MAX_TABS
      )
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            autoHideMenuBar: true,
            webPreferences: {
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      openLink(details.url);
      return { action: "deny" };
    });
    contents.on("did-create-window", (popup) => {
      if (this.#projects.get(projectId) !== project) {
        popup.destroy();
        return;
      }
      project.popups.add(popup);
      popup.once("closed", () => project.popups.delete(popup));
      guardNavigation(popup.webContents);
      popup.webContents.setWindowOpenHandler(({ url }) => {
        openLink(url);
        return { action: "deny" };
      });
    });
    contents.on("did-start-loading", () => {
      tab.error = undefined;
      publish();
    });
    contents.on("did-stop-loading", publish);
    contents.on("did-navigate", (_event, url) => {
      tab.url = url;
      publish();
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url;
        publish();
      }
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      publish();
    });
    contents.on("page-favicon-updated", (_event, icons) => {
      tab.favicon = icons.find(isBrowserUrl);
      publish();
    });
    contents.on(
      "did-fail-load",
      (_event, code, description, url, isMainFrame) => {
        // -3 is a navigation the page or the person cancelled.
        if (!isMainFrame || code === -3) return;
        tab.error = description || `The page didn't load (${code}).`;
        if (url) tab.url = url;
        publish();
      },
    );
    contents.on("render-process-gone", () => {
      tab.error = "The page stopped. Reload it to try again.";
      publish();
    });
    contents.on("enter-html-full-screen", () => {
      project.fullscreen = true;
      this.#place(project);
    });
    contents.on("leave-html-full-screen", () => {
      project.fullscreen = false;
      this.#place(project);
    });
    contents.on("before-input-event", (event, input) => {
      const command = browserShortcut(input);
      if (!command) return;
      event.preventDefault();
      if (command === "reload") contents.reload();
      else if (command === "back") {
        if (contents.navigationHistory.canGoBack())
          contents.navigationHistory.goBack();
      } else if (command === "forward") {
        if (contents.navigationHistory.canGoForward())
          contents.navigationHistory.goForward();
      } else if (command === "close-tab") this.close(projectId, tab.id);
      else this.options.onCommand(projectId, command);
    });
    contents.on("context-menu", (_event, params) => {
      Menu.buildFromTemplate(
        contextMenu(params, contents, project.labels, (url) => {
          if (
            this.#projects.get(projectId) === project &&
            project.tabs.length < BROWSER_MAX_TABS
          )
            this.open(projectId, url);
        }),
      ).popup();
    });
    void contents.loadURL(tab.url).catch(() => {});
  }

  #closeView(project: Project, tab: Tab): void {
    const view = tab.view;
    if (!view) return;
    tab.view = undefined;
    if (project.parent && !project.parent.isDestroyed())
      project.parent.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed())
      view.webContents.close({ waitForBeforeUnload: false });
  }

  #place(project: Project): void {
    const parent = project.editor?.window;
    if (project.parent !== parent) {
      if (project.parent && !project.parent.isDestroyed())
        for (const tab of project.tabs)
          if (tab.view) project.parent.contentView.removeChildView(tab.view);
      project.parent = parent;
    }
    const active = this.#activeTab(project);
    for (const tab of project.tabs) {
      const view = tab.view;
      if (!view || view.webContents.isDestroyed()) continue;
      let visible = false;
      if (tab === active && parent && !parent.isDestroyed() && project.editor) {
        if (!parent.contentView.children.includes(view))
          parent.contentView.addChildView(view);
        const [width, height] = parent.getContentSize();
        if (project.fullscreen) {
          view.setBounds({ x: 0, y: 0, width, height });
          visible = parent.isVisible() && !parent.isMinimized();
        } else {
          const zoom = parent.webContents.getZoomFactor();
          const input = project.editor.bounds;
          const x = Math.max(0, Math.min(width, Math.round(input.x * zoom)));
          const y = Math.max(0, Math.min(height, Math.round(input.y * zoom)));
          view.setBounds({
            x,
            y,
            width: Math.max(
              0,
              Math.min(width - x, Math.round(input.width * zoom)),
            ),
            height: Math.max(
              0,
              Math.min(height - y, Math.round(input.height * zoom)),
            ),
          });
          visible =
            project.editor.visible &&
            input.width > 0 &&
            input.height > 0 &&
            parent.isVisible() &&
            !parent.isMinimized() &&
            !tab.error;
        }
      }
      view.setVisible(visible);
      // A page in a hidden tab keeps running, as a background tab does, but stays quiet.
      view.webContents.setAudioMuted(!visible);
    }
  }

  #tabState(tab: Tab): BrowserTab {
    const contents =
      tab.view && !tab.view.webContents.isDestroyed()
        ? tab.view.webContents
        : undefined;
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: contents?.isLoading() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      ...(tab.favicon ? { favicon: tab.favicon } : {}),
      ...(tab.error ? { error: tab.error } : {}),
    };
  }

  #publish(projectId: string): void {
    this.options.onState(this.state(projectId));
  }
}

type Shortcut = BrowserCommand | "reload" | "back" | "forward" | "close-tab";

/** The browser keys a page with focus doesn't get: reload, back and forward, new and close tab, the address. */
export function browserShortcut(
  input: Pick<Input, "type" | "key" | "control" | "meta" | "shift" | "alt">,
): Shortcut | undefined {
  if (input.type !== "keyDown") return undefined;
  const mac = process.platform === "darwin";
  const command = mac ? input.meta : input.control;
  const key = input.key.toLowerCase();
  if (key === "f5" && !command && !input.alt) return "reload";
  if (input.alt && !command && !input.shift && !mac) {
    if (key === "arrowleft") return "back";
    if (key === "arrowright") return "forward";
  }
  if (!command || input.alt) return undefined;
  if (input.shift) return undefined;
  if (key === "r") return "reload";
  if (key === "l") return "focus-address";
  if (key === "t") return "new-tab";
  if (key === "w") return "close-tab";
  if (key === "[") return "back";
  if (key === "]") return "forward";
  return undefined;
}

function contextMenu(
  params: ContextMenuParams,
  contents: WebContents,
  labels: BrowserMenuLabels,
  openTab: (url: string) => void,
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL && isBrowserUrl(params.linkURL)) {
    items.push(
      { label: labels.openLinkInNewTab, click: () => openTab(params.linkURL) },
      {
        label: labels.copyLink,
        click: () => clipboard.writeText(params.linkURL),
      },
      { type: "separator" },
    );
  }
  if (params.isEditable)
    items.push(
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
    );
  else if (params.selectionText)
    items.push({ role: "copy" }, { type: "separator" });
  items.push(
    {
      label: labels.back,
      enabled: contents.navigationHistory.canGoBack(),
      click: () => contents.navigationHistory.goBack(),
    },
    {
      label: labels.forward,
      enabled: contents.navigationHistory.canGoForward(),
      click: () => contents.navigationHistory.goForward(),
    },
    { label: labels.reload, click: () => contents.reload() },
    { type: "separator" },
    {
      label: labels.inspect,
      click: () => contents.inspectElement(params.x, params.y),
    },
  );
  return items;
}
