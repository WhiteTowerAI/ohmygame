// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  PluginBrowserShortcut,
  BrowserCommand,
  BrowserSettings,
  BrowserState,
  BrowserTab,
  DesktopBrowserBridge,
  ProjectBrowser,
} from "../src/shared/browser.js";

let saved: ProjectBrowser;
let settings: BrowserSettings;
const api = {
  getPluginBrowserShortcuts: vi.fn(
    async (): Promise<PluginBrowserShortcut[]> => [],
  ),
  getProjectBrowser: vi.fn(async () => saved),
  getBrowserSettings: vi.fn(async () => settings),
  setBrowserSettings: vi.fn(async (next: BrowserSettings) => next),
  saveBrowserTabs: vi.fn(async () => {}),
  recordBrowserVisit: vi.fn(async () => {}),
  forgetBrowserVisit: vi.fn(async () => {}),
  clearBrowserVisits: vi.fn(async () => {}),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { BrowserPanel, frequentSites } =
  await import("../src/renderer/browser-panel.js");

const tab = (
  id: string,
  url: string,
  extra: Partial<BrowserTab> = {},
): BrowserTab => ({
  id,
  url,
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  ...extra,
});

/** A desktop side that keeps tabs in memory and reports them as the app does. */
function fakeBridge() {
  let state: BrowserState = { projectId: "p1", tabs: [] };
  const listeners = new Set<(state: BrowserState) => void>();
  const commands = new Set<
    (projectId: string, command: BrowserCommand) => void
  >();
  const publish = (next: BrowserState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const bridge = {
    attach: vi.fn(
      async (
        _projectId: string,
        _attachment: string,
        _layout: unknown,
        restored: ProjectBrowser,
      ) => {
        publish({
          projectId: "p1",
          tabs: restored.tabs.map((entry) =>
            tab(entry.id, entry.url, { title: entry.title }),
          ),
          ...(restored.active ? { active: restored.active } : {}),
        });
        return state;
      },
    ),
    layout: vi.fn(async () => {}),
    ready: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    capture: vi.fn(async () => new Uint8Array()),
    clearData: vi.fn(async () => {}),
    open: vi.fn(async (_projectId: string, url = "") => {
      publish({
        ...state,
        tabs: [...state.tabs, tab(`t${state.tabs.length + 1}`, url)],
        active: `t${state.tabs.length + 1}`,
      });
      return state;
    }),
    navigate: vi.fn(async (_projectId: string, tabId: string, url: string) => {
      publish({
        ...state,
        tabs: state.tabs.map((entry) =>
          entry.id === tabId ? { ...entry, url, loading: true } : entry,
        ),
      });
    }),
    select: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    back: vi.fn(async () => {}),
    forward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    onState: (listener: (state: BrowserState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onCommand: (
      listener: (projectId: string, command: BrowserCommand) => void,
    ) => {
      commands.add(listener);
      return () => commands.delete(listener);
    },
  } satisfies DesktopBrowserBridge;
  return {
    bridge,
    publish,
    state: () => state,
    command: (command: BrowserCommand) => {
      for (const listener of commands) listener("p1", command);
    },
  };
}

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = { tabs: [], visits: [] };
  settings = {
    shortcuts: [{ title: "Docs", url: "https://docs.example.com/" }],
    searchEngine: "bing",
    hiddenPluginShortcuts: [],
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(
  bridge: DesktopBrowserBridge,
  props: {
    openRequests?: readonly { url: string }[];
    pluginsRevision?: number;
  } = {},
): Promise<void> {
  await act(async () =>
    root.render(
      <BrowserPanel bridge={bridge} projectId="p1" visible {...props} />,
    ),
  );
  await act(async () => {});
}
const address = () =>
  host.querySelector<HTMLInputElement>('input[aria-label="Address"]')!;
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  );
const shortcut = (title: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".browser-shortcut")].find(
    (item) =>
      item.querySelector(".browser-shortcut-title")?.textContent === title,
  );
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("opens a new tab with the person's shortcuts, and goes where one leads", async () => {
  const desktop = fakeBridge();
  await render(desktop.bridge);
  expect(desktop.bridge.attach).toHaveBeenCalledWith(
    "p1",
    expect.any(String),
    expect.objectContaining({ visible: false }),
    saved,
    expect.objectContaining({ openLinkInNewTab: "Open link in new tab" }),
  );
  expect(desktop.bridge.open).toHaveBeenCalledWith("p1", undefined);
  expect(host.querySelector('[role="tab"]')?.textContent).toBe("New tab");
  await act(async () => shortcut("Docs")!.click());
  expect(desktop.bridge.navigate).toHaveBeenCalledWith(
    "p1",
    "t1",
    "https://docs.example.com/",
  );
  // Loading isn't a visit yet; a loaded page is, once.
  expect(api.recordBrowserVisit).not.toHaveBeenCalled();
  await act(async () =>
    desktop.publish({
      ...desktop.state(),
      tabs: [tab("t1", "https://docs.example.com/", { title: "Docs home" })],
    }),
  );
  await act(async () =>
    desktop.publish({
      ...desktop.state(),
      tabs: [tab("t1", "https://docs.example.com/", { title: "Docs home" })],
    }),
  );
  expect(api.recordBrowserVisit).toHaveBeenCalledTimes(1);
  expect(api.recordBrowserVisit).toHaveBeenCalledWith(
    "p1",
    "https://docs.example.com/",
    "Docs home",
  );
  expect(api.saveBrowserTabs).toHaveBeenLastCalledWith(
    "p1",
    [{ id: "t1", url: "https://docs.example.com/", title: "Docs home" }],
    "t1",
  );
  expect(host.querySelector('[role="tab"]')?.textContent).toBe("Docs home");
  expect(address().value).toBe("https://docs.example.com/");
});

it("searches what isn't an address, with the chosen engine", async () => {
  const desktop = fakeBridge();
  settings = { ...settings, searchEngine: "duckduckgo" };
  await render(desktop.bridge);
  await act(async () => type(address(), "pixel art tiles"));
  await act(async () => address().form!.requestSubmit());
  expect(desktop.bridge.navigate).toHaveBeenLastCalledWith(
    "p1",
    "t1",
    "https://duckduckgo.com/?q=pixel%20art%20tiles",
  );
  await act(async () => type(address(), "localhost:5173"));
  await act(async () => address().form!.requestSubmit());
  expect(desktop.bridge.navigate).toHaveBeenLastCalledWith(
    "p1",
    "t1",
    "http://localhost:5173/",
  );
});

it("brings back a project's tabs without counting them as visits again", async () => {
  const desktop = fakeBridge();
  saved = {
    tabs: [
      { id: "a", url: "https://example.com/", title: "Example" },
      { id: "b", url: "", title: "" },
    ],
    active: "a",
    visits: [],
  };
  await render(desktop.bridge);
  expect(desktop.bridge.open).not.toHaveBeenCalled();
  expect(
    [...host.querySelectorAll('[role="tab"]')].map((item) => item.textContent),
  ).toEqual(["Example", "New tab"]);
  expect(host.querySelector(".browser-new-tab")).toBeNull();
  expect(api.recordBrowserVisit).not.toHaveBeenCalled();
});

it("says why a page didn't load and reloads it", async () => {
  const desktop = fakeBridge();
  saved = {
    tabs: [{ id: "a", url: "https://missing.example/", title: "" }],
    active: "a",
    visits: [],
  };
  await render(desktop.bridge);
  await act(async () =>
    desktop.publish({
      projectId: "p1",
      active: "a",
      tabs: [
        tab("a", "https://missing.example/", {
          error: "ERR_NAME_NOT_RESOLVED",
        }),
      ],
    }),
  );
  expect(host.querySelector(".browser-error")?.textContent).toContain(
    "ERR_NAME_NOT_RESOLVED",
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".browser-error button")!.click(),
  );
  expect(desktop.bridge.reload).toHaveBeenCalledWith("p1", "a");
});

it("lets the person add and remove shortcuts and lists the sites visited most in the project", async () => {
  const desktop = fakeBridge();
  saved = {
    tabs: [],
    visits: [
      {
        url: "https://once.example/",
        title: "Once",
        count: 1,
        last: "2026-11-13T02:00:00.000Z",
      },
      {
        url: "https://often.example/",
        title: "Often",
        count: 5,
        last: "2026-11-12T00:00:00.000Z",
      },
    ],
  };
  await render(desktop.bridge);
  expect(
    [...host.querySelectorAll(".browser-frequent button > span")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["Often", "Once"]);
  await act(async () => button("Edit")!.click());
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Remove Docs"]')!
      .click(),
  );
  expect(api.setBrowserSettings).toHaveBeenLastCalledWith({
    shortcuts: [],
    searchEngine: "bing",
    hiddenPluginShortcuts: [],
  });
  await act(async () => shortcut("Add")!.click());
  const [name, url] = [
    ...host.querySelectorAll<HTMLInputElement>(".browser-shortcut-form input"),
  ];
  await act(async () => {
    type(name!, "Kenney");
    type(url!, "kenney.nl/assets");
  });
  await act(async () =>
    host
      .querySelector<HTMLFormElement>(".browser-shortcut-form")!
      .requestSubmit(),
  );
  expect(api.setBrowserSettings).toHaveBeenLastCalledWith({
    shortcuts: [{ title: "Kenney", url: "https://kenney.nl/assets" }],
    searchEngine: "bing",
    hiddenPluginShortcuts: [],
  });
});

it("removes a visited site immediately and restores it if saving fails", async () => {
  const desktop = fakeBridge();
  saved.visits = [
    { url: "https://often.example/", title: "Often", count: 3, last: "2026-11-13" },
    { url: "https://other.example/", title: "Other", count: 1, last: "2026-11-12" },
  ];
  let reject!: (error: Error) => void;
  api.forgetBrowserVisit.mockReturnValueOnce(new Promise((_resolve, fail) => {
    reject = fail;
  }));
  const removeOften = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Remove Often"]');
  await render(desktop.bridge);
  await act(async () => removeOften()!.click());
  expect(removeOften()).toBeNull();
  expect(host.querySelector(".browser-frequent")?.textContent).toContain("Other");
  expect(api.forgetBrowserVisit).toHaveBeenCalledWith("p1", saved.visits[0]!.url);
  await act(async () => reject(new Error("Could not remove visit")));
  expect(removeOften()).not.toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not remove visit");

  await act(async () => removeOften()!.click());
  expect(removeOften()).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("reorders shortcuts and keeps focus with the moved entry", async () => {
  settings.shortcuts.push(
    { title: "Art", url: "https://art.example/" },
    { title: "Games", url: "https://games.example/" },
  );
  await render(fakeBridge().bridge);
  await act(async () => button("Edit")!.click());
  const move = (label: string) =>
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(move("Move Docs left").disabled).toBe(true);
  expect(move("Move Games right").disabled).toBe(true);
  const docsRight = move("Move Docs right");
  docsRight.focus();
  await act(async () => docsRight.click());
  expect([...host.querySelectorAll(".browser-shortcut-title")].map((item) => item.textContent))
    .toEqual(["Art", "Docs", "Games", "Add"]);
  expect(api.setBrowserSettings).toHaveBeenLastCalledWith({
    ...settings,
    shortcuts: [settings.shortcuts[1], settings.shortcuts[0], settings.shortcuts[2]],
  });
  expect(document.activeElement).toBe(move("Move Docs right"));
  expect(move("Move Art left").disabled).toBe(true);

  await act(async () => move("Move Docs right").click());
  expect(move("Move Docs right").disabled).toBe(true);
  expect(document.activeElement).toBe(shortcut("Docs"));
});

it.each([
  { siteData: true, visits: false },
  { siteData: false, visits: true },
  { siteData: true, visits: true },
])("clears only the selected browser data ($siteData, $visits)", async ({ siteData, visits }) => {
  saved.visits = [{ url: "https://often.example/", title: "Often", count: 3, last: "2026-11-13" }];
  const desktop = fakeBridge();
  await render(desktop.bridge);
  const open = () => button("Clear browsing data…")!.click();
  const dialog = () => document.body.querySelector('[role="dialog"]')!;
  const dialogButton = (text: string) => [...dialog().querySelectorAll("button")].find((item) => item.textContent === text)!;
  await act(async () => open());
  const [sites, history] = dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(sites?.checked).toBe(true);
  expect(history?.checked).toBe(false);
  await act(async () => dialogButton("Cancel").click());
  expect(dialog()).toBeNull();
  expect(desktop.bridge.clearData).not.toHaveBeenCalled();
  expect(api.clearBrowserVisits).not.toHaveBeenCalled();

  await act(async () => open());
  const [siteOption, visitOption] = dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => siteOption!.click());
  expect(dialogButton("Clear data").disabled).toBe(true);
  if (siteData) await act(async () => siteOption!.click());
  if (visits) await act(async () => visitOption!.click());
  await act(async () => dialogButton("Clear data").click());

  expect(desktop.bridge.clearData).toHaveBeenCalledTimes(Number(siteData));
  expect(api.clearBrowserVisits).toHaveBeenCalledTimes(Number(visits));
  if (visits) expect(api.clearBrowserVisits).toHaveBeenCalledWith("p1");
  expect(Boolean(host.querySelector(".browser-frequent"))).toBe(!visits);
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Browsing data cleared.");
  expect(desktop.state().tabs).toHaveLength(1);
});

it("keeps visits made after the project history clear started", async () => {
  const desktop = fakeBridge();
  saved.visits = [{ url: "https://old.example/", title: "Old", count: 3, last: "2026-11-13" }];
  let finishClear!: () => void;
  api.clearBrowserVisits.mockReturnValueOnce(new Promise<void>((resolve) => {
    finishClear = resolve;
  }));
  await render(desktop.bridge);
  await act(async () => button("Clear browsing data…")!.click());
  const dialog = document.body.querySelector('[role="dialog"]')!;
  const [sites, history] = dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  await act(async () => sites!.click());
  await act(async () => history!.click());
  await act(async () => [...dialog.querySelectorAll("button")].find((item) => item.textContent === "Clear data")!.click());
  await act(async () => desktop.publish({
    ...desktop.state(),
    tabs: [...desktop.state().tabs, tab("new", "https://new.example/", { title: "New" })],
  }));
  expect(api.recordBrowserVisit).not.toHaveBeenCalled();
  await act(async () => finishClear());
  expect(api.recordBrowserVisit).toHaveBeenCalledWith("p1", "https://new.example/", "New");
  expect(host.querySelector(".browser-frequent span")?.textContent).toBe("New");
  expect(host.querySelector(".browser-frequent li:nth-child(2)")).toBeNull();
});

it("follows the browser keys a page hands back", async () => {
  const desktop = fakeBridge();
  saved = {
    tabs: [{ id: "a", url: "https://example.com/", title: "Example" }],
    active: "a",
    visits: [],
  };
  await render(desktop.bridge);
  await act(async () => desktop.command("new-tab"));
  expect(desktop.bridge.open).toHaveBeenCalledWith("p1", undefined);
  await act(async () => desktop.command("focus-address"));
  expect(document.activeElement).toBe(address());
});

it("ranks a project's sites by visits, then by when they were last visited", () => {
  const visit = (url: string, count: number, last: string) => ({
    url,
    title: "",
    count,
    last,
  });
  expect(
    frequentSites([
      visit("a", 1, "2026-01-02"),
      visit("b", 3, "2026-01-01"),
      visit("c", 1, "2026-01-03"),
    ]).map((entry) => entry.url),
  ).toEqual(["b", "c", "a"]);
});

it("opens requests once, including the first tab and requests beside restored tabs", async () => {
  const desktop = fakeBridge();
  const openRequest = { url: "https://plugin.example/" };
  await render(desktop.bridge, { openRequests: [openRequest] });
  expect(desktop.bridge.open).toHaveBeenCalledTimes(1);
  expect(desktop.state().tabs.map((tab) => tab.url)).toEqual([openRequest.url]);
  await render(desktop.bridge, { openRequests: [openRequest] });
  expect(desktop.bridge.open).toHaveBeenCalledTimes(1);
  await render(desktop.bridge, {
    openRequests: [openRequest, { ...openRequest }],
  });
  expect(desktop.bridge.open).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  root = createRoot(host);
  saved = {
    tabs: [{ id: "saved", url: "https://saved.example/", title: "Saved" }],
    active: "saved",
    visits: [],
  };
  const restored = fakeBridge();
  await render(restored.bridge, { openRequests: [openRequest] });
  expect(restored.state().tabs.map((tab) => tab.url)).toEqual([
    "https://saved.example/",
    openRequest.url,
  ]);
  expect(restored.bridge.open).toHaveBeenCalledTimes(1);
});

it("loads plugin shortcuts and removes them when the project's plugins change", async () => {
  const desktop = fakeBridge();
  api.getPluginBrowserShortcuts.mockResolvedValueOnce([
    {
      plugin: "acme/docs",
      pluginTitle: "Docs plugin",
      title: "Plugin docs",
      url: "https://plugin.example/",
    },
  ]);
  await render(desktop.bridge);
  await act(async () => shortcut("Plugin docs")!.click());
  expect(desktop.bridge.navigate).toHaveBeenCalledWith(
    "p1",
    "t1",
    "https://plugin.example/",
  );
  await act(async () =>
    desktop.publish({ projectId: "p1", tabs: [tab("t1", "")], active: "t1" }),
  );
  await render(desktop.bridge, { pluginsRevision: 1 });
  expect(api.getPluginBrowserShortcuts).toHaveBeenCalledTimes(2);
  expect(shortcut("Plugin docs")).toBeUndefined();
});

it("hides and restores an installed plugin's shortcut on the new-tab page", async () => {
  api.getPluginBrowserShortcuts.mockResolvedValueOnce([
    { plugin: "acme/docs", pluginTitle: "Docs", title: "Plugin docs", url: "https://plugin.example/" },
  ]);
  const desktop = fakeBridge();
  await render(desktop.bridge);
  const hide = host.querySelector<HTMLButtonElement>('button[aria-label="Hide Plugin docs"]')!;
  hide.focus();
  await act(async () => hide.click());
  expect(host.querySelector('button[aria-label="Hide Plugin docs"]')).toBeNull();
  const summary = host.querySelector<HTMLElement>("summary")!;
  expect(summary.textContent).toBe("Show 1 hidden");
  expect(document.activeElement).toBe(summary);
  expect(api.setBrowserSettings).toHaveBeenLastCalledWith({
    ...settings, hiddenPluginShortcuts: ["acme/docs https://plugin.example/"],
  });
  await act(async () => { summary.closest("details")!.open = true; });
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Show Plugin docs again"]')!.click());
  expect(summary.isConnected).toBe(false);
  expect(document.activeElement).toBe(shortcut("Plugin docs"));
  expect(api.setBrowserSettings).toHaveBeenLastCalledWith(settings);
  expect(desktop.bridge.navigate).not.toHaveBeenCalled();
});

it("keeps every request that arrives while saved tabs are loading", async () => {
  let resolve!: (value: ProjectBrowser) => void;
  api.getProjectBrowser.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const desktop = fakeBridge();
  const first = { url: "https://first.example/" };
  const second = { url: "https://second.example/" };
  await render(desktop.bridge, { openRequests: [first] });
  await render(desktop.bridge, { openRequests: [first, second] });
  await act(async () => resolve(saved));
  expect(desktop.state().tabs.map((tab) => tab.url)).toEqual([
    first.url,
    second.url,
  ]);
  expect(desktop.bridge.open).toHaveBeenCalledTimes(2);
});

it("keeps saving other tabs when a page changes to an address too long to restore", async () => {
  const desktop = fakeBridge();
  await render(desktop.bridge);
  const long = `https://example.com/#${"x".repeat(4000)}`;
  await act(async () =>
    desktop.publish({
      projectId: "p1",
      active: "b",
      tabs: [tab("a", long), tab("b", "https://other.example/")],
    }),
  );
  expect(api.saveBrowserTabs).toHaveBeenLastCalledWith(
    "p1",
    [
      { id: "a", url: "", title: "" },
      { id: "b", url: "https://other.example/", title: "" },
    ],
    "b",
  );
  expect(api.recordBrowserVisit).not.toHaveBeenCalledWith(
    "p1",
    long,
    expect.anything(),
  );
});
