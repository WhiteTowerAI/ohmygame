// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  assets = [
    { id: "hero", name: "hero.webp", size: 2048, mediaType: "image", contentType: "image/webp", createdAt: "2026-10-01T00:00:00Z", origin: "generated", prompt: "Ancient forest shrine", width: 640, height: 480, projects: [forest, city], referenceOnly: false },
    { id: "intro", name: "intro.mp4", size: 4096, mediaType: "video", contentType: "video/mp4", createdAt: "2026-10-02T00:00:00Z", origin: "uploaded", duration: 3, projects: [forest], referenceOnly: false },
    { id: "theme", name: "theme.mp3", size: 1024, mediaType: "audio", contentType: "audio/mpeg", createdAt: "2026-10-03T00:00:00Z", origin: "generated", projects: [], referenceOnly: false },
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
const openTile = (name: string) => click([...document.querySelectorAll(".ui-media")].find((tile) => tile.textContent?.includes(name))!);

it("shows every asset as a tile with where it is used and where it came from, and filters by kind and search", async () => {
  expect(tiles()).toEqual(["hero.webp", "intro.mp4", "theme.mp3"]);
  const meta = [...document.querySelectorAll(".ui-media-meta")].map((item) => item.textContent);
  expect(meta).toEqual(["2 projects · Generated", "Forest · Uploaded", "No project · Generated"]);
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
