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
    expect([...container.querySelectorAll("dd")].every((entry) => entry.textContent!.length > 8)).toBe(true);
    expect(container.textContent).not.toContain("assetCanvas.");
    if (category === "characters") expect(container.textContent).toContain(language === "en" ? "Dialogue" : "剧情对话");
    if (category === "animation") {
      expect(container.textContent).toContain(language === "en" ? "Every action below uses it" : "下面每个动作都会参考它");
      expect(container.textContent).toContain(language === "en" ? "not animation frames" : "不是连续动作帧");
    }
    if (category === "skins") expect(container.textContent).toContain(language === "en" ? "not an animation set" : "不生成整套动作动画");
  }
});
