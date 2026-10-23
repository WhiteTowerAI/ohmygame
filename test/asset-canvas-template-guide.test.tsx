// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCanvasTemplateGuide } from "../src/renderer/asset-canvas-template-guide.js";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows all pixel asset examples without controls that add nodes", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="pixel-art" />));
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(10);
  expect(container.querySelectorAll(".asset-template-guide-option > svg")).toHaveLength(10);
  expect(container.querySelector(".asset-template-guide-option > img")).toBeNull();
  expect(container.textContent).toContain("A complete side-view game character");
  expect(container.querySelector("button")).toBeNull();
});

it("shows output guidance for both sequence modes without add controls", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="free-sequence" />));
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(2);
  expect(container.querySelectorAll(".asset-template-guide-option > svg")).toHaveLength(2);
  expect(container.textContent).toContain("12 continuous frames");
  expect(container.textContent).toContain("9 scenes");
  expect(container.querySelector("button")).toBeNull();
});

it("puts action-set output guidance in its introduction", async () => {
  await act(async () => root.render(<AssetCanvasTemplateGuide template="action-set" />));
  expect(container.textContent).toContain("All six actions share the same character reference");
  expect(container.querySelector("button")).toBeNull();
});
