// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { LibraryAssetReference } from "../src/renderer/api.js";
import type { LibraryAssetSummary } from "../src/shared/contracts.js";

const forest = { id: "forest", name: "Forest", type: "web-game" as const };
const city = { id: "city", name: "City", type: "web-game" as const };
let assets: LibraryAssetSummary[];
let references: Record<string, LibraryAssetReference[]>;
const api = {
  listLibraryAssets: vi.fn(async () => assets.map((asset) => ({ ...asset }))),
  listLibraryAssetReferences: vi.fn(async (id: string) => references[id] ?? []),
  deleteLibraryAsset: vi.fn(async (id: string) => { assets = assets.filter((asset) => asset.id !== id); }),
  forceDeleteLibraryAsset: vi.fn(async (id: string) => { assets = assets.filter((asset) => asset.id !== id); }),
  getLibraryAsset: vi.fn(async () => new Blob([], { type: "video/mp4" })),
  renameLibraryAsset: vi.fn(async (id: string, name: string) => {
    const asset = assets.find((item) => item.id === id)!;
    asset.name = `${name}${asset.name.slice(asset.name.lastIndexOf("."))}`;
    return asset;
  }),
};

vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/runtime-connection.js")>()),
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  ...api,
  waitForRuntime: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/use-workspace-asset-url.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/use-workspace-asset-url.js")>()),
  useWorkspaceAssetUrl: () => ({ url: "blob:asset", loading: false, retry: () => {} }),
}));
vi.doMock(path.resolve("src/renderer/page-frame.tsx"), () => ({ PageFrame: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const { LibraryPage } = await import("../src/renderer/library.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
const onOpenProject = vi.fn();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  assets = [
    { id: "hero", name: "hero.webp", size: 2048, mediaType: "image", contentType: "image/webp", createdAt: "2026-10-03T00:00:00Z", origin: "generated", prompt: "Ancient forest shrine", width: 640, height: 480, projects: [forest, city], referenceOnly: false },
    { id: "intro", name: "intro.mp4", size: 4096, mediaType: "video", contentType: "video/mp4", createdAt: "2026-10-02T00:00:00Z", origin: "uploaded", duration: 3, projects: [forest], referenceOnly: false },
    { id: "theme", name: "theme.mp3", size: 1024, mediaType: "audio", contentType: "audio/mpeg", createdAt: "2026-10-01T00:00:00Z", origin: "generated", projects: [], referenceOnly: false },
  ];
  references = { hero: [{ id: "forest", name: "Forest" }, { id: "city", name: "City" }] } as unknown as Record<string, LibraryAssetReference[]>;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<LibraryPage onNavigate={() => {}} onOpenProject={onOpenProject} />));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const tiles = () => [...document.querySelectorAll(".ui-media-name-text")].map((name) => name.textContent);
const tab = (name: RegExp) => [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((item) => name.test(item.textContent ?? ""))!;
const button = (name: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name)!;
const click = (element: Element) => act(async () => { (element as HTMLElement).click(); });
const choose = async (label: string, option: string) => {
  await click(document.querySelector(`[aria-label="${label}"]`)!);
  await click([...document.querySelectorAll("[role=option]")].find((item) => item.textContent === option)!);
};
const openTile = (name: string) => click([...document.querySelectorAll(".ui-media")].find((tile) => tile.textContent?.includes(name))!);

it("shows a recording saved while the page is open", async () => {
  let announce!: () => void;
  const desktop = window as unknown as { ohMyGameDesktop?: unknown };
  desktop.ohMyGameDesktop = { webGamePlayer: { recording: { onSaved: (listener: typeof announce) => { announce = listener; return () => {}; } } } };
  try {
    await act(async () => root!.unmount());
    root = createRoot(container!);
    await act(async () => root!.render(<LibraryPage onNavigate={() => {}} onOpenProject={onOpenProject} />));
    assets.push({ ...assets[1]!, id: "clip", name: "clip.mp4" });
    expect(tiles()).not.toContain("clip.mp4");
    await act(async () => announce());
    expect(tiles()).toContain("clip.mp4");
  } finally {
    delete desktop.ohMyGameDesktop;
  }
});

it("sorts the list, shows the value it sorts by, and keeps the sort through a filter reset", async () => {
  await choose("Sort assets", "Largest first");
  expect(tiles()).toEqual(["intro.mp4", "hero.webp", "theme.mp3"]);
  expect(document.querySelector(".ui-media-meta")?.textContent).toBe("4.0 KB · Forest · Uploaded");
  expect(localStorage.getItem("ohmygame:library-sort")).toBe("largest");

  await choose("Date added", "Today");
  expect(tiles()).toEqual([]);
  await click(button("Reset filters"));
  expect(tiles()).toEqual(["intro.mp4", "hero.webp", "theme.mp3"]);
  expect(document.querySelector('[aria-label="Sort assets"]')?.textContent).toContain("Largest first");
});

it("shows every asset as a tile with where it is used and where it came from, and filters by kind and search", async () => {
  expect(tiles()).toEqual(["hero.webp", "intro.mp4", "theme.mp3"]);
  const meta = [...document.querySelectorAll(".ui-media-meta")].map((item) => item.textContent);
  expect(meta.map((item) => item?.replace(/^[^·]+ · /, ""))).toEqual(["2 projects · Generated", "Forest · Uploaded", "No project · Generated"]);
  expect(document.querySelector(".ui-media-badge")?.textContent).toBe("0:03");
  expect(tab(/^All assets/).textContent).toBe("All assets3");
  expect(tab(/^Videos/).textContent).toBe("Videos1");

  await click(tab(/^Videos/));
  expect(tiles()).toEqual(["intro.mp4"]);
  await click(tab(/^All assets/));

  const search = document.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "shrine");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(tiles()).toEqual(["hero.webp"]);
  expect(tab(/^Images/).textContent).toBe("Images1");
  expect(tab(/^Audio/).textContent).toBe("Audio0");
  await click(button("Reset filters"));
  expect(tiles()).toHaveLength(3);
});

it("opens details with the prompt, and opens the one project using an asset", async () => {
  await openTile("intro.mp4");
  const sheet = document.querySelector(".ui-sheet")!;
  expect(sheet.querySelector(".ui-dialog-title")?.textContent).toBe("intro.mp4");
  expect(sheet.querySelector(".library-sheet-props")?.textContent).toContain("Forest");
  await click(button("Open project", sheet));
  expect(onOpenProject).toHaveBeenCalledWith("forest");

  await openTile("hero.webp");
  expect(document.querySelector(".library-sheet-section p")?.textContent).toBe("Ancient forest shrine");
  expect(document.querySelector(".library-sheet-props")?.textContent).toContain("640 × 480");
});

it("plays an audio tile in place, one at a time, and still opens its details from the name", async () => {
  const play = vi.fn(async () => {});
  const pause = vi.fn();
  vi.stubGlobal("Audio", class {
    paused = true;
    src = "";
    currentTime = 0;
    listeners: Record<string, () => void> = {};
    addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
    removeAttribute() { this.src = ""; }
    play() { this.paused = false; this.listeners.play?.(); return play(); }
    pause() { this.paused = true; this.listeners.pause?.(); pause(); }
  });
  const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:theme");
  const revoked = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  onTestFinished(() => { created.mockRestore(); revoked.mockRestore(); });
  await click(button("Play theme.mp3"));
  expect(api.getLibraryAsset).toHaveBeenCalledWith("theme");
  expect(play).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".library-audio-tile")?.classList.contains("is-playing")).toBe(true);
  expect(document.querySelector(".ui-sheet")).toBeNull();
  await click(button("Pause theme.mp3"));
  expect(pause).toHaveBeenCalled();
  expect(document.querySelector(".library-audio-tile")?.classList.contains("is-paused")).toBe(true);

  await openTile("theme.mp3");
  expect(document.querySelector(".ui-sheet .ui-dialog-title")?.textContent).toBe("theme.mp3");
  // Opening the details stops the tile, so only the sheet's player is heard.
  expect(document.querySelector(".library-audio-tile")?.className).toBe("library-audio-tile");
  expect(revoked).toHaveBeenCalledWith("blob:theme");
  await click(button("Close", document.querySelector(".ui-sheet")!));

  // Deleting the sound while it plays stops it with its tile.
  await click(button("Play theme.mp3"));
  pause.mockClear();
  const area = document.querySelector(".library-audio-tile")!.closest(".ui-context-area")!;
  await act(async () => { area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 1 })); });
  await click([...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((item) => item.textContent === "Delete")!);
  await click(button("Delete", document.querySelector(".ui-dialog")!));
  expect(tiles()).toEqual(["hero.webp", "intro.mp4"]);
  expect(pause).toHaveBeenCalled();
});

it("deletes an asset used by projects everywhere after listing them", async () => {
  await openTile("hero.webp");
  await click(button("Delete", document.querySelector(".ui-sheet")!));
  const dialog = document.querySelector(".ui-dialog")!;
  expect(document.querySelector(".ui-sheet")).toBeNull();
  expect(dialog.querySelector(".ui-dialog-title")?.textContent).toBe("Delete asset everywhere?");
  expect([...dialog.querySelectorAll(".library-delete-projects li")].map((item) => item.textContent)).toEqual(["Forest", "City"]);
  await click(button("Delete everywhere", dialog));
  expect(api.forceDeleteLibraryAsset).toHaveBeenCalledWith("hero");
  expect(api.deleteLibraryAsset).not.toHaveBeenCalled();
  expect(document.querySelector(".ui-dialog, .ui-sheet")).toBeNull();
  expect(tiles()).toEqual(["intro.mp4", "theme.mp3"]);
});

it("deletes an unused asset after a plain confirmation, and keeps it on cancel", async () => {
  await openTile("theme.mp3");
  await click(button("Delete", document.querySelector(".ui-sheet")!));
  expect(document.querySelector(".ui-dialog-title")?.textContent).toBe("Delete “theme.mp3”?");
  await click(button("Cancel", document.querySelector(".ui-dialog")!));
  expect(document.querySelector(".ui-sheet .ui-dialog-title")?.textContent).toBe("theme.mp3");

  await click(button("Delete", document.querySelector(".ui-sheet")!));
  await click(button("Delete", document.querySelector(".ui-dialog")!));
  expect(api.deleteLibraryAsset).toHaveBeenCalledWith("theme");
  expect(tiles()).toEqual(["hero.webp", "intro.mp4"]);
});

it("renames an asset from its details and keeps them open on the new name", async () => {
  await openTile("intro.mp4");
  await click(button("Rename", document.querySelector(".ui-sheet")!));
  const input = document.querySelector<HTMLInputElement>(".ui-dialog input")!;
  expect(input.value).toBe("intro");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Opening");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(button("Save", document.querySelector(".ui-dialog")!));
  expect(api.renameLibraryAsset).toHaveBeenCalledWith("intro", "Opening");
  expect(document.querySelector(".ui-sheet .ui-dialog-title")?.textContent).toBe("Opening.mp4");
});

it("offers trimming for videos only, in its own dialog", async () => {
  await openTile("hero.webp");
  expect(button("Trim", document.querySelector(".ui-sheet")!)).toBeUndefined();
  await openTile("intro.mp4");
  await click(button("Trim", document.querySelector(".ui-sheet")!));
  const dialog = document.querySelector(".ui-dialog")!;
  expect(dialog.querySelector(".ui-dialog-title")?.textContent).toBe("Trim intro.mp4");
  expect(dialog.querySelector(".video-trimmer video")).not.toBeNull();
  expect(button("Save as new video", dialog).disabled).toBe(true);
  await click(button("Cancel", dialog));
  expect(document.querySelector(".ui-sheet .ui-dialog-title")?.textContent).toBe("intro.mp4");
});

it("resumes automatic paging when refresh replaces the end of a list of the same size", async () => {
  const { useListPage } = await import("../src/renderer/use-list-page.js");
  const observed = new Map<Element, () => void>();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly notify: IntersectionObserverCallback) {}
    target?: Element;
    observe(target: Element) {
      this.target = target;
      observed.set(target, () => this.notify([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver));
    }
    disconnect() { if (this.target) observed.delete(this.target); }
  });
  function List({ loading }: { loading: boolean }) {
    const page = useListPage(100);
    return <>{page.limit}{loading ? null : page.next}</>;
  }
  for (const loading of [false, true, false]) {
    await act(async () => root!.render(<List loading={loading} />));
    expect(observed.size).toBe(loading ? 0 : 1);
  }
  await act(async () => { observed.values().next().value!(); });
  expect(container?.textContent).toContain("96");
});
