// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibraryAsset } from "../src/renderer/library-assets.js";
import { LibraryAssetPicker } from "../src/renderer/node-workbench.js";

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
