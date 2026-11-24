// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { ImageModel } from "../src/shared/contracts.js";
import { AssetCanvasPresetDialog } from "../src/renderer/asset-canvas-preset-dialog.js";
import { PIXELLAB_PROVIDER } from "../src/renderer/asset-canvas-pixellab-presets.js";

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

const frameAnimation: ImageModel = {
  provider: PIXELLAB_PROVIDER, id: "frame-animation", name: "Frame animation", providerName: "PixelLab", sizes: [],
  generationOptions: [{ resolution: "512", aspectRatio: "1:1" }], supportsReferenceImage: true, maxReferenceImages: 1,
  minReferenceImages: 1, maxOutputs: 1, protocol: "plugin",
};

async function render(imageModels: ImageModel[]) {
  const handlers = { onClose: vi.fn(), onSelectPixel: vi.fn(), onSelectEffect: vi.fn(), onSelectPixelLab: vi.fn(), onOpenPixelLab: vi.fn() };
  await act(async () => root.render(<AssetCanvasPresetDialog imageModels={imageModels} {...handlers} />));
  return handlers;
}
const button = (text: string) => [...document.body.querySelectorAll("button")].find((item) => item.textContent?.startsWith(text))!;
const card = (label: string) => [...document.body.querySelectorAll("button")].find((item) => item.querySelector("strong")?.textContent === label)!;
const click = (element: HTMLElement) => act(async () => element.click());

it.each(["en", "zh-CN"])("switches between preset packs and offers PixelLab once it is set up, in %s", async (language) => {
  await i18next.changeLanguage(language);
  const zh = language === "zh-CN";
  const handlers = await render([]);
  expect(document.body.querySelector("h2")?.textContent).toBe(zh ? "素材预设" : "Asset presets");
  expect(document.body.textContent).not.toContain("assetCanvas.");

  await click(button(zh ? "像素风" : "Pixel art"));
  await click(card(zh ? "角色设定图" : "Character reference sheet"));
  expect(handlers.onSelectPixel).toHaveBeenCalledOnce();

  // Without the plugin the pack lists its presets, unusable, and links to the plugin.
  await click(button("PixelLab"));
  // Cards with an example show it at its pixel size, enlarged with hard edges.
  const knight = card(zh ? "创建四方向角色" : "Create character with 4 directions");
  expect(knight.querySelector("img")?.getAttribute("src")).toBe("https://assets.ohmygame.ai/template-examples/pixellab/character-4.gif");
  expect(knight.querySelector(".canvas-preset-card-thumbnail")?.classList.contains("is-pixelated")).toBe(true);
  // PixelLab's presets are one list, without a category column.
  expect(document.body.querySelector("[role=tablist]")).toBeNull();
  expect(card(zh ? "文字生成动画" : "Animate with text").disabled).toBe(true);
  await click(button(zh ? "设置 PixelLab" : "Set up PixelLab"));
  expect(handlers.onOpenPixelLab).toHaveBeenCalledOnce();

  // An earlier plugin has only some of the models.
  const updated = await render([frameAnimation]);
  expect(card(zh ? "物件动画" : "Animate object").disabled).toBe(true);
  await click(card(zh ? "文字生成动画" : "Animate with text"));
  expect(updated.onSelectPixelLab).toHaveBeenCalledWith("pixellab:frame-animation");
  expect(button(zh ? "更新 PixelLab" : "Update PixelLab")).toBeTruthy();
});
