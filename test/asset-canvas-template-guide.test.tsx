// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssetCanvasTemplateGuide, PixelAssetTemplateGuide } from "../src/renderer/asset-canvas-template-guide.js";
import i18next from "i18next";
import { PIXEL_ASSET_TEMPLATE_CATEGORIES, pixelAssetTemplatePresetIds } from "../src/renderer/asset-canvas-pixel-workflows.js";
import { TEMPLATE_COVER_IMAGES } from "../src/renderer/asset-canvas-template-samples.js";
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
  await i18next.changeLanguage("en");
});

it.each(["en", "zh-CN"])("explains every output in all six template canvases in %s", async (language) => {
  await i18next.changeLanguage(language);
  for (const category of PIXEL_ASSET_TEMPLATE_CATEGORIES) {
    await act(async () => root.render(<PixelAssetTemplateGuide category={category} />));
    expect(container.querySelectorAll("dt")).toHaveLength(pixelAssetTemplatePresetIds(category).length);
    expect([...container.querySelectorAll("dd")].every((entry) => entry.textContent!.length > 20)).toBe(true);
    expect(container.textContent).not.toContain("assetCanvas.");
    if (category === "characters") expect(container.textContent).toContain(language === "en" ? "dialogue" : "剧情对话");
    if (category === "animation") {
      expect(container.textContent).toContain(language === "en" ? "12-frame static sheet" : "12 帧静态图集");
      expect(container.textContent).toContain(language === "en" ? "not consecutive animation frames" : "不是连续动作帧");
    }
    if (category === "skins") expect(container.textContent).toContain(language === "en" ? "does not generate a full animation set" : "不直接生成整套动作动画");
  }
});

it("shows the new pixel overview and keeps guidance for all twelve asset types", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="pixel-art" />),
  );
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(12);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(
    container
      .querySelector(".asset-template-guide-preview img")
      ?.getAttribute("src"),
  ).toBe(TEMPLATE_COVER_IMAGES["pixel-art"]);
  expect(
    [...choices].every((choice) => choice.querySelector("img") === null),
  ).toBe(true);
  expect(container.textContent).toContain(
    "A complete side-view game character",
  );
  expect(container.textContent).toContain("One continuous terrain area");
  expect(container.textContent).toContain("A square terrain tile atlas");
  expect(container.querySelector("button")).toBeNull();
});

it("shows the matching example and output guidance for both sequence modes", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="free-sequence" />),
  );
  const choices = container.querySelectorAll(".asset-template-guide-option");
  expect(choices).toHaveLength(2);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(
    container
      .querySelector(".asset-template-guide-preview img")
      ?.getAttribute("src"),
  ).toBe(TEMPLATE_COVER_IMAGES["free-sequence"]);
  expect(container.textContent).toContain("12 continuous frames");
  expect(container.textContent).toContain("9 pixel art game scenes");
  expect(container.querySelector("button")).toBeNull();
});

it("shows the supplied action overview with its output guidance", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="action-set" />),
  );
  expect(container.querySelectorAll("img")).toHaveLength(1);
  const image = container.querySelector(".asset-template-guide-preview img");
  expect(image?.getAttribute("src")).toBe(TEMPLATE_COVER_IMAGES["action-set"]);
  expect(image?.getAttribute("draggable")).toBe("false");
  expect(container.textContent).toContain(
    "All six actions share the same character reference",
  );
  expect(container.querySelector("button")).toBeNull();
});

it.each(["character-sheet"] as const)(
  "keeps %s tutorial guidance without a sample image or empty preview",
  async (template) => {
    await act(async () =>
      root.render(<AssetCanvasTemplateGuide template={template} />),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".asset-template-guide-preview")).toBeNull();
    expect(container.textContent).toContain(
      t(`assetCanvasTemplates.${template}.guide`),
    );
    expect(container.textContent).toContain(
      t(`assetCanvasTemplates.${template}.output`),
    );
    expect(container.querySelector("svg")).toBeNull();
  },
);

it("shows the outfit cover in its introduction and preserves the instructions", async () => {
  await act(async () =>
    root.render(<AssetCanvasTemplateGuide template="quick-reskin" />),
  );
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(
    container
      .querySelector(".asset-template-guide-preview img")
      ?.getAttribute("src"),
  ).toBe(TEMPLATE_COVER_IMAGES["quick-reskin"]);
  expect(container.textContent).toContain(
    t("assetCanvasTemplates.quick-reskin.guide"),
  );
  expect(container.textContent).toContain(
    t("assetCanvasTemplates.quick-reskin.output"),
  );
});
