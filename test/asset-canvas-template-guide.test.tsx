// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCanvasTemplateGuide } from "../src/renderer/asset-canvas-template-guide.js";
import { TEMPLATE_SAMPLE_IMAGES } from "../src/renderer/asset-canvas-template-samples.js";
import { t } from "../src/renderer/i18n.js";

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

it("shows all ten bundled pixel asset examples without controls that add nodes", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="pixel-art" />),
  );
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(10);
  expect(
    [...choices].map((choice) =>
      choice.querySelector("img")?.getAttribute("src"),
    ),
  ).toEqual(
    [
      "side-view-character",
      "rpg-character",
      "portrait",
      "monster",
      "animal",
      "scene",
      "terrain",
      "building",
      "prop",
      "icon",
    ].map(
      (sample) =>
        TEMPLATE_SAMPLE_IMAGES[sample as keyof typeof TEMPLATE_SAMPLE_IMAGES],
    ),
  );
  expect(container.textContent).toContain(
    "A complete side-view game character",
  );
  expect(container.querySelector("button")).toBeNull();
});

it("shows the matching example and output guidance for both sequence modes", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="free-sequence" />),
  );
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(2);
  expect(
    [...choices].map((choice) =>
      choice.querySelector("img")?.getAttribute("src"),
    ),
  ).toEqual([
    TEMPLATE_SAMPLE_IMAGES["continuous-sequence"],
    TEMPLATE_SAMPLE_IMAGES["consistent-sequence"],
  ]);
  expect(container.textContent).toContain("12 continuous frames");
  expect(container.textContent).toContain("9 scenes");
  expect(container.querySelector("button")).toBeNull();
});

it("composes all six action examples with their output guidance", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="action-set" />),
  );
  const collage = container.querySelector(
    ".asset-template-demo.is-collage.is-action-set",
  );
  expect(collage).not.toBeNull();
  expect(
    [...collage!.querySelectorAll("img")].map((image) =>
      image.getAttribute("src"),
    ),
  ).toEqual(
    ["idle", "walk", "run", "attack", "hurt", "down"].map(
      (sample) =>
        TEMPLATE_SAMPLE_IMAGES[sample as keyof typeof TEMPLATE_SAMPLE_IMAGES],
    ),
  );
  expect(container.textContent).toContain(
    "All six actions share the same character reference",
  );
  expect(container.querySelector("button")).toBeNull();
});

it.each(["character-sheet", "quick-reskin"] as const)(
  "keeps %s tutorial guidance without a sample image or empty preview",
  async (template) => {
    await act(async () =>
      root.render(<AssetCanvasTemplateGuide template={template} />),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".asset-template-guide-preview")).toBeNull();
    expect(container.textContent).toContain(t(`assetCanvasTemplates.${template}.guide`));
    expect(container.textContent).toContain(t(`assetCanvasTemplates.${template}.output`));
    expect(container.querySelector("svg")).toBeNull();
  },
);
