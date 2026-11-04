// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PixelAssetTemplateGuide } from "../src/renderer/asset-canvas-template-guide.js";
import i18next from "i18next";
import { PIXEL_ASSET_TEMPLATE_CATEGORIES, pixelAssetTemplatePresetIds } from "../src/renderer/asset-canvas-pixel-workflows.js";

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
