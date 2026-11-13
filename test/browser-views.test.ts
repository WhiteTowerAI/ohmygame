import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserState } from "../src/shared/browser.js";

const electron = vi.hoisted(() => {
  class Events {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    on(name: string, handler: (...args: any[]) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
    }
    once(name: string, handler: (...args: any[]) => void) {
      this.on(name, handler);
    }
    emit(name: string, ...args: any[]) {
      for (const handler of this.handlers.get(name) ?? []) handler(...args);
    }
  }
  class Contents extends Events {
    destroyed = false;
    loading = false;
    back = false;
    openHandler?: (details: { url: string; disposition: string }) => {
      action: string;
    };
    navigationHistory = {
      canGoBack: () => this.back,
      canGoForward: () => false,
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    loadURL = vi.fn(async (_url: string) => {});
    reload = vi.fn();
    stop = vi.fn();
    isLoading = () => this.loading;
    setWindowOpenHandler = vi.fn((handler) => {
      this.openHandler = handler;
    });
    setAudioMuted = vi.fn();
    getZoomFactor = () => 1;
    isDestroyed = () => this.destroyed;
    close = vi.fn(() => {
      this.destroyed = true;
    });
    capturePage = vi.fn(async () => ({ toJPEG: () => new Uint8Array([7]) }));
  }
  class View {
    webContents = new Contents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
    constructor(readonly options: Record<string, any>) {
      views.push(this);
    }
  }
  class Window extends Events {
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    destroyed = false;
    webContents = new Contents();
    contentView = {
      children: [] as View[],
      addChildView: (view: View) => {
        this.contentView.children.push(view);
      },
      removeChildView: (view: View) => {
        this.contentView.children = this.contentView.children.filter(
          (item) => item !== view,
        );
      },
    };
    getContentSize = () => [1000, 800];
    isDestroyed = () => this.destroyed;
    isMinimized = () => false;
    isVisible = () => true;
  }
  const views: View[] = [];
  const browserSession = {
    getUserAgent: () =>
      "Mozilla/5.0 Chrome/140.0 Electron/43.3.0 ohmygame/0.1.0 Safari/537.36",
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
  return {
    View,
    Window,
    views,
    browserSession,
    fromPartition: vi.fn(() => browserSession),
  };
});
vi.mock("electron", () => ({
  WebContentsView: electron.View,
  session: { fromPartition: electron.fromPartition },
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  clipboard: { writeText: vi.fn() },
}));
import {
  BROWSER_PARTITION,
  BrowserViews,
  browserShortcut,
} from "../src/desktop/browser-views.js";

const labels = {
  openLinkInNewTab: "Open",
  copyLink: "Copy",
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  inspect: "Inspect",
};
const layout = {
  bounds: { x: 300, y: 100, width: 600, height: 500 },
  visible: true,
};
const saved = {
  tabs: [
    { id: "a", url: "https://example.com/", title: "Example" },
    { id: "b", url: "https://other.example/", title: "Other" },
  ],
  active: "a",
  visits: [],
};

function create() {
  const states: BrowserState[] = [];
  const commands: string[] = [];
  const openExternal = vi.fn();
  const views = new BrowserViews({
    onState: (state) => states.push(state),
    onCommand: (_projectId, command) => commands.push(command),
    openExternal,
  });
  const window = new electron.Window();
  return {
    views,
    window,
    states,
    commands,
    openExternal,
    editor: window as unknown as Electron.BrowserWindow,
  };
}

beforeEach(() => {
  electron.views.length = 0;
  vi.clearAllMocks();
});

describe("the Browser panel's pages", () => {
  it("opens saved tabs, loading only the one shown, in a session of their own", () => {
    const { views, window, editor } = create();
    const state = views.attach("p1", "panel", editor, layout, saved, labels);
    expect(state).toMatchObject({
      projectId: "p1",
      active: "a",
      tabs: [
        { id: "a", url: "https://example.com/", title: "Example" },
        { id: "b", url: "https://other.example/" },
      ],
    });
    expect(electron.views).toHaveLength(1);
    expect(electron.fromPartition).toHaveBeenCalledWith(BROWSER_PARTITION);
    expect(electron.views[0]!.options.webPreferences).toMatchObject({
      session: electron.browserSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(electron.browserSession.setUserAgent).toHaveBeenCalledWith(
      "Mozilla/5.0 Chrome/140.0 Safari/537.36",
    );
    expect(electron.views[0]!.webContents.loadURL).toHaveBeenCalledWith(
      "https://example.com/",
    );
    expect(window.contentView.children).toEqual([electron.views[0]]);
    expect(electron.views[0]!.setBounds).toHaveBeenLastCalledWith({
      x: 300,
      y: 100,
      width: 600,
      height: 500,
    });
    expect(electron.views[0]!.setVisible).toHaveBeenLastCalledWith(true);

    // Another tab loads when it is first shown; the first hides and goes quiet.
    views.select("p1", "b");
    expect(electron.views).toHaveLength(2);
    expect(electron.views[1]!.webContents.loadURL).toHaveBeenCalledWith(
      "https://other.example/",
    );
    expect(electron.views[0]!.setVisible).toHaveBeenLastCalledWith(false);
    expect(
      electron.views[0]!.webContents.setAudioMuted,
    ).toHaveBeenLastCalledWith(true);
    expect(electron.views[1]!.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("refuses what isn't a web page and asks for nothing a page wants without a prompt", () => {
    const { views, editor } = create();
    views.attach(
      "p1",
      "panel",
      editor,
      layout,
      { tabs: [], visits: [] },
      labels,
    );
    expect(() => views.open("p1", "file:///etc/hosts")).toThrow(
      /web pages only/,
    );
    const {
      tabs: [tab],
    } = views.open("p1");
    expect(tab).toMatchObject({ url: "", title: "" });
    // A new tab shows the panel's own page, with no page loaded behind it.
    expect(electron.views).toHaveLength(0);
    expect(() => views.navigate("p1", tab!.id, "javascript:alert(1)")).toThrow(
      /web pages only/,
    );
    views.navigate("p1", tab!.id, "https://example.com/");
    expect(electron.views[0]!.webContents.loadURL).toHaveBeenCalledWith(
      "https://example.com/",
    );

    const [request] =
      electron.browserSession.setPermissionRequestHandler.mock.calls[0]!;
    const answer = vi.fn();
    request(null, "media", answer);
    expect(answer).toHaveBeenLastCalledWith(false);
    request(null, "clipboard-sanitized-write", answer);
    expect(answer).toHaveBeenLastCalledWith(true);
  });

  it("opens links meant for a new tab beside the page, and keeps a sized popup's opener", () => {
    const { views, editor, openExternal } = create();
    views.attach("p1", "panel", editor, layout, saved, labels);
    const contents = electron.views[0]!.webContents;
    expect(
      contents.openHandler!({
        url: "https://example.com/next",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(views.state("p1").tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/",
      "https://other.example/",
      "https://example.com/next",
    ]);
    expect(
      contents.openHandler!({
        url: "https://accounts.example/sign-in",
        disposition: "new-window",
      }),
    ).toMatchObject({ action: "allow" });
    expect(
      contents.openHandler!({
        url: "mailto:team@example.com",
        disposition: "foreground-tab",
      }),
    ).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("mailto:team@example.com");
  });

  it("reports pages as they load, and hides one that failed so the panel can say why", () => {
    const { views, editor, states } = create();
    views.attach("p1", "panel", editor, layout, saved, labels);
    const view = electron.views[0]!;
    view.webContents.emit("did-navigate", {}, "https://example.com/after");
    view.webContents.emit("page-title-updated", {}, "After");
    expect(states.at(-1)!.tabs[0]).toMatchObject({
      url: "https://example.com/after",
      title: "After",
    });
    view.webContents.emit(
      "did-fail-load",
      {},
      -105,
      "ERR_NAME_NOT_RESOLVED",
      "https://missing.example/",
      true,
    );
    expect(states.at(-1)!.tabs[0]).toMatchObject({
      url: "https://missing.example/",
      error: "ERR_NAME_NOT_RESOLVED",
    });
    views.layout("p1", "panel", layout);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    // A cancelled navigation isn't a failure.
    view.webContents.emit(
      "did-fail-load",
      {},
      -3,
      "ERR_ABORTED",
      "https://example.com/",
      true,
    );
    views.reload("p1", "a");
    expect(view.webContents.reload).toHaveBeenCalled();
    expect(views.state("p1").tabs[0]!.error).toBeUndefined();
  });

  it("closes tabs, moving to a neighbour, and closes every page with the panel", () => {
    const { views, window, editor } = create();
    views.attach("p1", "panel", editor, layout, saved, labels);
    views.close("p1", "a");
    expect(views.state("p1")).toMatchObject({
      active: "b",
      tabs: [{ id: "b" }],
    });
    expect(electron.views[0]!.webContents.close).toHaveBeenCalled();
    // A panel that was replaced leaves the pages to the new one.
    views.attach("p1", "panel-2", editor, layout, saved, labels);
    views.detach("p1", "panel");
    expect(views.state("p1").tabs).toHaveLength(1);
    views.detach("p1", "panel-2");
    expect(views.state("p1").tabs).toEqual([]);
    expect(window.contentView.children).toEqual([]);
    expect(electron.views.every((view) => view.webContents.destroyed)).toBe(
      true,
    );
    expect(() => views.open("p1")).toThrow(/isn't open/);
  });

  it("guards popups and releases all native pages when their owner reloads", () => {
    const { views, editor } = create();
    views.attach("p1", "panel", editor, layout, saved, labels);
    const contents = electron.views[0]!.webContents;
    const popup = new electron.Window();
    contents.emit("did-create-window", popup);
    const preventDefault = vi.fn();
    popup.webContents.emit("will-navigate", {
      url: "file:///tmp/private",
      preventDefault,
    });
    popup.webContents.emit(
      "will-redirect",
      { preventDefault },
      "file:///tmp/private",
    );
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(
      popup.webContents.openHandler!({
        url: "https://example.com/next",
        disposition: "new-window",
      }),
    ).toEqual({ action: "deny" });
    expect(views.state("p1").tabs).toHaveLength(3);
    views.dispose();
    expect(popup.isDestroyed()).toBe(true);
    expect(electron.views.every((view) => view.webContents.destroyed)).toBe(
      true,
    );
    expect(views.state("p1").tabs).toEqual([]);
  });

  it("hands the panel's keys back when a page has focus", () => {
    const key = (
      key: string,
      extra: Partial<{
        meta: boolean;
        control: boolean;
        shift: boolean;
        alt: boolean;
      }> = {},
    ) =>
      browserShortcut({
        type: "keyDown",
        key,
        meta: false,
        control: false,
        shift: false,
        alt: false,
        ...(process.platform === "darwin" ? { meta: true } : { control: true }),
        ...extra,
      });
    expect(key("l")).toBe("focus-address");
    expect(key("t")).toBe("new-tab");
    expect(key("w")).toBe("close-tab");
    expect(key("r")).toBe("reload");
    expect(key("[")).toBe("back");
    expect(key("t", { shift: true })).toBeUndefined();
    expect(key("c")).toBeUndefined();
    expect(
      browserShortcut({
        type: "keyDown",
        key: "F5",
        meta: false,
        control: false,
        shift: false,
        alt: false,
      }),
    ).toBe("reload");
    expect(
      browserShortcut({
        type: "keyUp",
        key: "l",
        meta: true,
        control: true,
        shift: false,
        alt: false,
      }),
    ).toBeUndefined();
  });
});
