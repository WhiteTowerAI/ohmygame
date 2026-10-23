// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCanvasTemplateGuide } from "../src/renderer/asset-canvas-template-guide.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onAdd = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onAdd.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps pixel choices inside the guide and adds the selected type", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="pixel-art" runtime={{ onAdd }} />));
  const choices = container.querySelectorAll<HTMLButtonElement>(".asset-template-guide-options button");
  expect(choices).toHaveLength(10);
  expect(container.textContent).toContain("A complete side-view game character");
  await act(async () => choices[7]!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(".asset-template-guide-add")!.click());
  expect(onAdd).toHaveBeenCalledWith("building");
});

it("shows sequence output guidance and adds the chosen mode", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="free-sequence" runtime={{ onAdd }} />));
  const choices = container.querySelectorAll<HTMLButtonElement>(".asset-template-guide-options button");
  expect(choices).toHaveLength(2);
  await act(async () => choices[1]!.click());
  expect(container.textContent).toContain("9 scenes");
  await act(async () => container.querySelector<HTMLButtonElement>(".asset-template-guide-add")!.click());
  expect(onAdd).toHaveBeenCalledWith("consistent-sequence");
});

it("puts action-set output guidance in its introduction", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="action-set" />));
  expect(container.textContent).toContain("All six actions share the same character reference");
  expect(container.querySelector(".asset-template-guide-add")).toBeNull();
});
