import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserSettingsStore,
  DEFAULT_BROWSER_SETTINGS,
  ProjectBrowserStore,
} from "../src/daemon/browser-store.js";
import { createApp } from "../src/daemon/app.js";
import { ensureOhMyGamePiEnvironment } from "../src/daemon/pi-agent.js";
import {
  BROWSER_MAX_TABS,
  BROWSER_MAX_VISITS,
  browserAddress,
  isBrowserUrl,
  type BrowserSettings,
  type ProjectBrowser,
} from "../src/shared/browser.js";
import type { ProjectState } from "../src/shared/contracts.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function folder(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-browser-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe("the address box", () => {
  it("opens addresses as they are, hosts over https, local servers over http, and searches the rest", () => {
    expect(browserAddress("https://example.com/a b", "bing")).toBe(
      "https://example.com/a%20b",
    );
    expect(browserAddress("example.com/docs", "bing")).toBe(
      "https://example.com/docs",
    );
    expect(browserAddress("localhost:5173", "bing")).toBe(
      "http://localhost:5173/",
    );
    expect(browserAddress("127.0.0.1:8080/play", "bing")).toBe(
      "http://127.0.0.1:8080/play",
    );
    expect(browserAddress("pixel art tiles", "google")).toBe(
      "https://www.google.com/search?q=pixel%20art%20tiles",
    );
    expect(browserAddress("phaser", "baidu")).toBe(
      "https://www.baidu.com/s?wd=phaser",
    );
    expect(browserAddress("  ", "bing")).toBe("");
    // Not a web page, so it's a search, never a navigation.
    expect(browserAddress("javascript:alert(1)", "duckduckgo")).toBe(
      "https://duckduckgo.com/?q=javascript%3Aalert(1)",
    );
    expect(browserAddress("file:///etc/passwd", "bing")).toMatch(
      /^https:\/\/www\.bing\.com\/search\?q=/,
    );
  });

  it("opens web pages only", () => {
    expect(isBrowserUrl("https://example.com")).toBe(true);
    expect(isBrowserUrl("http://localhost:3000")).toBe(true);
    for (const url of [
      "file:///tmp/x",
      "javascript:void 0",
      "chrome://settings",
      "https://user:secret@example.com",
      "not a url",
    ])
      expect(isBrowserUrl(url)).toBe(false);
  });
});

describe("browser records", () => {
  it("keep shared settings, and refuse ones that aren't web shortcuts", async () => {
    const dataDirectory = await folder();
    const store = new BrowserSettingsStore(dataDirectory);
    expect(await store.get()).toEqual(DEFAULT_BROWSER_SETTINGS);
    const settings: BrowserSettings = {
      shortcuts: [{ title: " Docs ", url: "https://docs.example.com/" }],
      searchEngine: "google",
    };
    expect(await store.set(settings)).toEqual({
      shortcuts: [{ title: "Docs", url: "https://docs.example.com/" }],
      searchEngine: "google",
    });
    expect(await new BrowserSettingsStore(dataDirectory).get()).toEqual({
      shortcuts: [{ title: "Docs", url: "https://docs.example.com/" }],
      searchEngine: "google",
    });
    await expect(
      store.set({
        shortcuts: [{ title: "Local file", url: "file:///etc/hosts" }],
        searchEngine: "bing",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      store.set({ shortcuts: [], searchEngine: "altavista" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("leave a settings file they can't read alone", async () => {
    const dataDirectory = await folder();
    const file = path.join(dataDirectory, "browser-settings.json");
    await writeFile(file, JSON.stringify({ version: 2, shortcuts: [] }));
    const store = new BrowserSettingsStore(dataDirectory);
    expect(await store.get()).toMatchObject({
      ...DEFAULT_BROWSER_SETTINGS,
      problem: expect.stringMatching(/can read/),
    });
    await expect(store.set(DEFAULT_BROWSER_SETTINGS)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      version: 2,
      shortcuts: [],
    });
  });

  it("refuse to overwrite a partially damaged project history", async () => {
    const directory = await folder();
    const file = path.join(directory, "browser.json");
    const original = JSON.stringify({
      version: 1,
      tabs: [],
      visits: [
        {
          url: "https://example.com/",
          title: "Example",
          count: 2,
          last: "2026-11-13",
        },
        { url: "broken", title: "Unreadable", count: 1, last: "2026-11-13" },
      ],
    });
    await writeFile(file, original);
    const store = new ProjectBrowserStore();
    expect((await store.get(directory)).problem).toContain("can read");
    await expect(store.setTabs(directory, { tabs: [] })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("keep a project's tabs and its most visited sites", async () => {
    const storage = await folder();
    const store = new ProjectBrowserStore();
    expect(await store.get(storage)).toEqual({ tabs: [], visits: [] });
    await store.setTabs(storage, {
      tabs: [
        { id: "a", url: "https://example.com/", title: "Example" },
        { id: "b", url: "", title: "" },
      ],
      active: "b",
    });
    await store.visit(storage, "https://example.com/", "Example");
    await store.visit(storage, "https://example.com/", "");
    await store.visit(storage, "https://other.example/", "Other");
    const saved = await new ProjectBrowserStore().get(storage);
    expect(saved.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(saved.active).toBe("b");
    expect(
      saved.visits.map(({ url, title, count }) => ({ url, title, count })),
    ).toEqual([
      { url: "https://other.example/", title: "Other", count: 1 },
      { url: "https://example.com/", title: "Example", count: 2 },
    ]);
    // Saving tabs keeps the visits, and an active tab that isn't there is dropped.
    await store.setTabs(storage, { tabs: [], active: "a" });
    expect(await store.get(storage)).toMatchObject({
      tabs: [],
      visits: [
        { url: "https://other.example/" },
        { url: "https://example.com/" },
      ],
    });
    expect((await store.get(storage)).active).toBeUndefined();

    await expect(
      store.setTabs(storage, {
        tabs: Array.from({ length: BROWSER_MAX_TABS + 1 }, (_, index) => ({
          id: `t${index}`,
          url: "",
          title: "",
        })),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      store.setTabs(storage, {
        tabs: [{ id: "x", url: "file:///tmp", title: "" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      store.visit(storage, "chrome://settings", ""),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("keep only the most recent visits", async () => {
    const storage = await folder();
    const store = new ProjectBrowserStore();
    for (let index = 0; index <= BROWSER_MAX_VISITS; index++)
      await store.visit(storage, `https://site${index}.example/`, "");
    const { visits } = await store.get(storage);
    expect(visits).toHaveLength(BROWSER_MAX_VISITS);
    expect(visits[0]!.url).toBe(`https://site${BROWSER_MAX_VISITS}.example/`);
  });
});

describe("browser API", () => {
  it("keeps settings, tabs and visits by project, in the app's data", async () => {
    const dataDirectory = await folder();
    await ensureOhMyGamePiEnvironment(path.join(dataDirectory, "pi-agent"));
    const app = createApp({
      dataDirectory,
      piAgentDirectory: path.join(dataDirectory, "pi-agent"),
      accessToken: "token",
    });
    cleanup.push(() => app.close());
    await app.ready();
    const call = async <T>(method: string, url: string, payload?: unknown) => {
      const response = await app.inject({
        method: method as "GET",
        url,
        headers: { authorization: "Bearer token" },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      return {
        status: response.statusCode,
        body: (response.body ? response.json() : undefined) as T,
      };
    };

    expect(
      (await call<BrowserSettings>("GET", "/settings/browser")).body,
    ).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(
      (
        await call<BrowserSettings>("PUT", "/settings/browser", {
          shortcuts: [],
          searchEngine: "duckduckgo",
        })
      ).body,
    ).toEqual({ shortcuts: [], searchEngine: "duckduckgo" });
    expect(
      (
        await call("PUT", "/settings/browser", {
          shortcuts: "none",
          searchEngine: "bing",
        })
      ).status,
    ).toBe(400);

    const project = (await call<ProjectState>("POST", "/projects", {})).body;
    const tabs = [{ id: "a", url: "https://example.com/", title: "Example" }];
    expect(
      (
        await call("PUT", `/projects/${project.id}/browser/tabs`, {
          tabs,
          active: "a",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("POST", `/projects/${project.id}/browser/visits`, {
          url: "https://example.com/",
          title: "Example",
        })
      ).status,
    ).toBe(204);
    const saved = (
      await call<ProjectBrowser>("GET", `/projects/${project.id}/browser`)
    ).body;
    expect(saved).toMatchObject({
      tabs,
      active: "a",
      visits: [{ url: "https://example.com/", count: 1 }],
    });
    // Never in the project's own folder.
    await expect(
      readFile(path.join(project.workspacePath, "browser.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(
      (
        await call("POST", `/projects/${project.id}/browser/visits`, {
          url: "file:///etc/hosts",
        })
      ).status,
    ).toBe(400);
    expect((await call("GET", "/projects/missing/browser")).status).toBe(404);
    expect(
      (await call("PUT", "/projects/missing/browser/tabs", { tabs: [] }))
        .status,
    ).toBe(404);
  });
});
