// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { LibraryAssetPicker } from "../src/renderer/library-asset-picker.js";

const project = { id: "forest", name: "Forest", type: "web-game" as const };
const otherProject = { id: "desert", name: "Desert", type: "web-game" as const };
const asset: LibraryAsset = {
  id: "hero", assetId: "", name: "hero.png", path: "hero.png", size: 1,
  mediaType: "image", contentType: "image/png", createdAt: "2026-10-15T00:00:00Z",
  origin: "generated", projects: [project],
};
const otherAsset: LibraryAsset = {
  ...asset, id: "villain", name: "villain.png", path: "villain.png", projects: [otherProject],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("defaults the Library picker to the current project", async () => {
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" projectId={project.id} project={project} assets={[asset, otherAsset]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  expect(document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")).toHaveLength(1);
  expect(document.querySelector<HTMLButtonElement>(".story-video-picker-list > button")?.title).toBe("hero.png");
  const trigger = document.querySelector<HTMLButtonElement>(".library-filter-trigger");
  expect(trigger).toBeTruthy();
  await act(async () => trigger!.click());
  const selects = document.querySelectorAll<HTMLSelectElement>(".library-filter-popover select");
  expect(selects).toHaveLength(2);
  expect([...selects].map((select) => ({ value: select.value, options: [...select.options].map((option) => option.value) }))).toEqual([
    { value: "saved", options: ["saved", "generated", "uploaded", "workspace", "all"] },
    { value: project.id, options: ["", "unassigned", otherProject.id, project.id] },
  ]);
});

it("keeps the current project in the filter when it has no Library assets", async () => {
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" projectId={project.id} project={project} assets={[otherAsset]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  expect(document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")).toHaveLength(0);
  const trigger = document.querySelector<HTMLButtonElement>(".library-filter-trigger");
  await act(async () => trigger!.click());
  const projectSelect = document.querySelectorAll<HTMLSelectElement>(".library-filter-popover select")[1]!;
  expect(projectSelect.value).toBe(project.id);
  expect([...projectSelect.options].map((option) => option.value)).toEqual(["", "unassigned", otherProject.id, project.id]);
});

it("opens the canvas's picker on what the Library page shows, with the project's media a tab away", async () => {
  // Uploaded on the Library page, in no project; saved from another project; a reference saved there too.
  const uploaded: LibraryAsset = { ...asset, id: "tree", name: "tree.png", path: "tree.png", origin: "uploaded", saved: true, projects: [] };
  const savedElsewhere: LibraryAsset = { ...otherAsset, saved: true };
  const reference: LibraryAsset = { ...asset, id: "sketch", name: "sketch.png", path: "sketch.png", origin: "uploaded", saved: true, referenceOnly: true, projects: [] };
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" libraryTab projectId={project.id} project={project} assets={[asset, uploaded, savedElsewhere, reference]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  const shown = () => [...document.querySelectorAll<HTMLButtonElement>(".story-video-picker-list > button")].map((button) => button.title);
  const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) => button.textContent === name)!;
  expect(tab("Library").getAttribute("aria-selected")).toBe("true");
  expect(shown()).toEqual(["tree.png", "villain.png", "sketch.png"]);
  // The Library's own list has no project or source filters.
  expect(document.querySelector(".library-filter-trigger")).toBeNull();
  const search = document.querySelector<HTMLInputElement>(".library-picker-toolbar input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "tree");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(shown()).toEqual(["tree.png"]);

  await act(async () => tab("This project").click());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(shown()).toEqual(["hero.png"]);
  expect(document.querySelector(".library-filter-trigger")).toBeTruthy();
});

it("says how to fill an empty Library", async () => {
  await act(async () => root.render(
    <LibraryAssetPicker title="From Library" libraryTab projectId={project.id} project={project} assets={[asset]} onClose={vi.fn()} onSelect={vi.fn()} />,
  ));
  expect(document.querySelector(".story-video-picker-list > p")?.textContent).toBe("Nothing is saved to the Library yet. Upload files on the Library page, or save a project's media to it.");
});
