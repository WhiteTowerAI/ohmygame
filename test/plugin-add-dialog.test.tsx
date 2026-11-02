// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginAddDialog } from "../src/renderer/plugin-add-dialog.js";
import type { MarketPlugin, PluginAddPreview } from "../src/shared/plugins.js";

const preview: PluginAddPreview = {
  source: { type: "npm", name: "@acme/maker", registry: "npmmirror", version: "1.0.0" },
  digest: "d".repeat(64),
  id: "acme/maker",
  version: "1.0.0",
  displayName: "Maker",
  description: "Makes things",
  appWide: false,
  asks: ["network:api.example.com"],
  skills: 2,
  mcpServers: ["API"],
  settings: true,
  installedVersions: [],
  origin: { type: "npm", package: "@acme/maker", version: "1.0.0", registry: "npmmirror" },
};

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ route: string; body: unknown }>;
let answer: (route: string) => Response;
const onClose = vi.fn();
const onAdded = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  answer = (route) => route.includes("inspect") ? Response.json(preview) : Response.json({ id: preview.id, version: preview.version }, { status: 201 });
  onClose.mockReset();
  onAdded.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const route = input.replace(/^\/api/, "");
    requests.push({ route, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return answer(route);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const open = () => act(async () => root.render(<PluginAddDialog onClose={onClose} onAdded={onAdded} />));
const dialog = () => document.querySelector<HTMLElement>(".ui-dialog")!;
const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = () => act(async () => document.querySelector<HTMLFormElement>("#plugin-add-form")!.requestSubmit());
const tab = (label: string) => act(async () => [...dialog().querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!.click());
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;

describe("PluginAddDialog", () => {
  it("shows what a package does before anything is added, then adds exactly what was reviewed", async () => {
    await open();
    expect(button("Continue").disabled).toBe(true);
    await type(dialog().querySelector<HTMLInputElement>('input[placeholder="@publisher/plugin"]')!, " @acme/maker ");
    await submit();
    expect(requests).toEqual([{ route: expect.stringMatching(/^\/plugin-sources\/inspect/), body: { source: { type: "npm", name: "@acme/maker", registry: expect.any(String) } } }]);
    expect(onAdded).not.toHaveBeenCalled();
    const text = dialog().textContent!;
    expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Add Maker?");
    for (const shown of ["acme/maker 1.0.0", "@acme/maker", "network:api.example.com", "API", "2 skills", "You approve what it asks for", "settings to fill in", "doesn't review"])
      expect(text, shown).toContain(shown);
    await submit();
    expect(requests[1]).toEqual({ route: "/plugin-sources/install", body: { source: preview.source, digest: preview.digest } });
    expect(onAdded).toHaveBeenCalledWith("acme/maker");
  });

  it("says what adding does to versions already installed", async () => {
    answer = () => Response.json({ ...preview, appWide: true, asks: [], mcpServers: [], settings: false, installedVersions: ["0.9.0", "1.0.0"] });
    await open();
    await tab("GitHub");
    await type(dialog().querySelector<HTMLInputElement>('input[type="url"]')!, "https://github.com/acme/maker");
    await submit();
    expect(requests[0]!.body).toEqual({ source: { type: "github", url: "https://github.com/acme/maker" } });
    const text = dialog().textContent!;
    expect(text).toContain("as soon as you add it");
    expect(text).toContain("Version 1.0.0 is already installed, with these same contents");
    expect(text).toContain("This replaces version 0.9.0");
  });

  it("doesn't change source while one is being read", async () => {
    let finish!: (response: Response) => void;
    answer = () => undefined as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    await open();
    await type(dialog().querySelector<HTMLInputElement>('input[placeholder="@publisher/plugin"]')!, "@acme/maker");
    await submit();
    await tab("GitHub");
    expect(dialog().querySelector('input[type="url"]')).toBeNull();
    await act(async () => finish(Response.json(preview)));
    expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Add Maker?");
  });

  it("stays on the review with the reason when adding fails, and Back returns to the source", async () => {
    answer = (route) => route.includes("inspect") ? Response.json(preview) : Response.json({ error: "This package changed after you reviewed it. Review it again." }, { status: 400 });
    await open();
    await type(dialog().querySelector<HTMLInputElement>('input[placeholder="@publisher/plugin"]')!, "@acme/maker");
    await submit();
    await submit();
    expect(onAdded).not.toHaveBeenCalled();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("changed after you reviewed it");
    await act(async () => button("Back").click());
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(dialog().querySelector<HTMLInputElement>('input[placeholder="@publisher/plugin"]')!.value).toBe("@acme/maker");
    await act(async () => button("Cancel").click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uploads a .tgz to review it and again to add it, and refuses one too large first", async () => {
    answer = (route) => route.includes("inspect") ? Response.json({ ...preview, source: undefined, origin: undefined }) : Response.json({ id: preview.id, version: preview.version }, { status: 201 });
    await open();
    await tab("This computer");
    const file = new File(["tgz"], "maker.tgz");
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await submit();
    expect(requests[0]!.route).toMatch(/^\/plugin-sources\/file\/inspect/);
    expect(requests[0]!.body).toBe(file);
    expect(dialog().textContent).toContain("maker.tgz");
    await submit();
    expect(requests[1]).toEqual({ route: `/plugin-sources/file/install?digest=${preview.digest}`, body: file });
    expect(onAdded).toHaveBeenCalledWith("acme/maker");

    await act(async () => root.render(null));
    requests.length = 0;
    await open();
    await tab("This computer");
    const large = new File(["tgz"], "large.tgz");
    Object.defineProperty(large, "size", { value: 60 * 1024 * 1024 });
    const again = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(again, "files", { configurable: true, value: [large] });
    await act(async () => again.dispatchEvent(new Event("change", { bubbles: true })));
    await submit();
    expect(requests).toEqual([]);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("50 MB");
  });

  it("offers a folder on the desktop and reviews what it picks", async () => {
    const selectPluginDirectory = vi.fn(async () => "/plugins/maker");
    Object.assign(window, { ohMyGameDesktop: { selectPluginDirectory } });
    try {
      answer = () => Response.json({ ...preview, source: { type: "directory", path: "/plugins/maker" }, origin: undefined });
      await open();
      await tab("This computer");
      await act(async () => button("Choose a folder…").click());
      expect(requests[0]!.body).toEqual({ source: { type: "directory", path: "/plugins/maker" } });
      expect(dialog().textContent).toContain("/plugins/maker");
    } finally {
      Object.assign(window, { ohMyGameDesktop: undefined });
    }
  });

  describe("for a plugin on the market", () => {
    const listed: MarketPlugin = {
      id: "acme/maker", package: "@acme/maker", version: "1.2.0", displayName: "Maker", description: "Makes things", asks: [],
      adds: { skills: 2, mcpServers: 1 }, featured: false, sourceVerified: true, repository: "https://github.com/acme/maker",
    };
    const openListed = (plugin = listed) => act(async () => root.render(<PluginAddDialog listed={plugin} onClose={onClose} onAdded={onAdded} />));

    it("opens on the review of that exact version, with where its source is", async () => {
      await openListed();
      expect(requests[0]).toMatchObject({ route: "/plugin-sources/inspect?locale=en", body: { source: { type: "npm", name: "@acme/maker", version: "1.2.0", market: true } } });
      expect(dialog().querySelector('[role="tab"]')).toBeNull();
      const link = dialog().querySelector<HTMLAnchorElement>('a[href="https://github.com/acme/maker"]')!;
      expect(link.textContent).toContain("acme/maker");
      expect(dialog().textContent).toContain("Source verified");
    });

    it("says when the source isn't verified, and closes rather than going back to a form", async () => {
      await openListed({ ...listed, sourceVerified: false });
      expect(dialog().textContent).toContain("Source not verified");
      expect(dialog().textContent).not.toContain("Source verified");
      await act(async () => button("Cancel").click());
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("adds what was reviewed, sending back its digest", async () => {
      await openListed();
      await act(async () => button("Add plugin").click());
      expect(requests.at(-1)).toMatchObject({ route: "/plugin-sources/install", body: { digest: preview.digest } });
      expect(onAdded).toHaveBeenCalledWith("acme/maker");
    });

    it("shows why a package couldn't be read", async () => {
      answer = () => Response.json({ error: "@acme/maker 1.2.0 was blocked: steals keys" }, { status: 400 });
      await openListed();
      expect(dialog().textContent).toContain("was blocked: steals keys");
      expect(button("Continue")).toBeUndefined();
    });
  });
});
