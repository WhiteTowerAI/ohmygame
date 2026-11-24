// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { ProjectCanvasPreset } from "../src/shared/plugins.js";

const previews = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../src/renderer/api.js", () => ({ readProjectPluginCanvasPresetPreview: previews.read }));
const { AssetCanvasPresetDialog } = await import("../src/renderer/asset-canvas-preset-dialog.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:knight", revokeObjectURL: vi.fn() }));
  previews.read.mockReset().mockResolvedValue(new Blob(["GIF89a"], { type: "image/gif" }));
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

const PRESETS: ProjectCanvasPreset[] = [
  { id: "ohmygame/pixellab:character", plugin: "ohmygame/pixellab", pluginName: "PixelLab", title: "Character", description: "Rotations of one character", preview: true },
  { id: "ohmygame/pixellab:tileset", plugin: "ohmygame/pixellab", pluginName: "PixelLab", title: "Tileset", description: "Terrain that tiles" },
  { id: "acme/frames:knight", plugin: "acme/frames", pluginName: "Frames", title: "Knight sheet" },
];

async function render(pluginPresets: ProjectCanvasPreset[]) {
  const handlers = { onClose: vi.fn(), onSelectWorkflow: vi.fn(), onSelectPlugin: vi.fn() };
  await act(async () => root.render(<AssetCanvasPresetDialog projectId="p1" pluginPresets={pluginPresets} {...handlers} />));
  return handlers;
}
const button = (text: string) => [...document.body.querySelectorAll("button")].find((item) => item.textContent?.startsWith(text))!;
const card = (label: string) => [...document.body.querySelectorAll("button")].find((item) => item.querySelector("strong")?.textContent === label)!;
const click = (element: HTMLElement) => act(async () => element.click());

it.each(["en", "zh-CN"])("offers the app's pixel workflows, and each plugin's presets as a pack of its own, in %s", async (language) => {
  await i18next.changeLanguage(language);
  const zh = language === "zh-CN";
  const handlers = await render(PRESETS);
  expect(document.body.querySelector("h2")?.textContent).toBe(zh ? "素材预设" : "Asset presets");
  expect(document.body.textContent).not.toContain("assetCanvas.");

  // Each pixel card is a whole workflow: a category's generators with their reference and guide.
  await click(button(zh ? "像素风" : "Pixel art"));
  expect(document.body.querySelector("[role=tablist]")).toBeNull();
  expect(document.body.querySelectorAll(".canvas-preset-grid > button")).toHaveLength(8);
  await click(card(zh ? "角色" : "Characters"));
  expect(handlers.onSelectWorkflow).toHaveBeenCalledWith("characters");

  // A plugin's pack is named after it, lists its presets in its order, without a category column.
  await click(button("PixelLab"));
  expect(document.body.querySelector("[role=tablist]")).toBeNull();
  expect([...document.body.querySelectorAll(".canvas-preset-grid strong")].map((item) => item.textContent)).toEqual(["Character", "Tileset"]);
  // Only presets with a preview are read, from the project's plugin.
  expect(previews.read).toHaveBeenCalledOnce();
  expect(previews.read).toHaveBeenCalledWith("p1", "ohmygame/pixellab:character", expect.any(AbortSignal));
  expect(card("Character").querySelector("img")?.getAttribute("src")).toBe("blob:knight");
  expect(card("Tileset").querySelector("img")).toBeNull();
  await click(card("Tileset"));
  expect(handlers.onSelectPlugin).toHaveBeenCalledWith(PRESETS[1]);

  // A search looks through every pack.
  const search = document.body.querySelector<HTMLInputElement>("[data-canvas-preset-search]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "knight");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect([...document.body.querySelectorAll(".canvas-preset-results h3")].map((item) => item.textContent)).toEqual(["Frames"]);
});

it("shows only the app's pack when no plugin offers presets", async () => {
  await render([]);
  expect([...document.body.querySelectorAll(".canvas-preset-packs button")].map((item) => item.textContent)).toEqual(["Pixel art"]);
  expect(previews.read).not.toHaveBeenCalled();
});
