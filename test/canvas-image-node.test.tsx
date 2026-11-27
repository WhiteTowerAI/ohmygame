// @vitest-environment happy-dom
import { ReactFlowProvider } from "@xyflow/react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImageNode } from "../src/renderer/asset-canvas-nodes.js";
import type { AssetCanvasFlowData } from "../src/renderer/asset-canvas-flow.js";
import type { ImageModel } from "../src/shared/contracts.js";

const plugin = { provider: "plugin.ohmygame.pixellab.pixellab", providerName: "PixelLab", protocol: "plugin" as const, sizes: [], generationOptions: [], supportsResolution: false, supportsAspectRatio: false, supportsReferenceImage: true, maxOutputs: 1 as const };
const character: ImageModel = {
  ...plugin, id: "character", name: "Character", maxReferenceImages: 1, referenceImageLabels: ["South view"],
  params: [
    { key: "directions", type: "select", title: "Directions", default: "8", options: [{ value: "4", title: "4 directions" }, { value: "8", title: "8 directions" }] },
    { key: "view", type: "select", title: "View", default: "low top-down", options: [{ value: "low top-down", title: "Low top-down" }, { value: "side", title: "Side" }] },
    { key: "outline", type: "boolean", title: "Outline", default: true },
  ],
};
const tileset: ImageModel = {
  ...plugin, id: "tileset", name: "Tileset", maxReferenceImages: 0, supportsReferenceImage: false,
  params: [
    { key: "upper", type: "text", title: "Upper terrain" },
    { key: "view", type: "select", title: "View", default: "high top-down", options: [{ value: "high top-down", title: "High top-down" }, { value: "side", title: "Side" }] },
  ],
};

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function renderImage(initial: AssetCanvasFlowData) {
  const changed = vi.fn();
  function Harness() {
    const [data, setData] = useState(initial);
    return <ReactFlowProvider><ImageNode selected data={{ ...data, panelOpen: true, imageRuntime: {
      models: [character, tileset], providers: [], references: [], maxReferences: 1, uploading: false, accept: "image/png", addLabel: "Add reference",
      busy: false, generating: false, onGenerate: vi.fn(), onRemoveReference: vi.fn(), onUploadSourceImage: vi.fn(), onSetSourceFile: vi.fn(), onUploadReferences: vi.fn(),
      onChange: (next) => { changed(next); setData(next); },
    } }} /></ReactFlowProvider>;
  }
  await act(async () => root.render(<Harness />));
  return changed;
}

async function pick(label: string, option: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}:"]`)!.click());
  const choice = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((node) => node.textContent?.includes(option));
  expect(choice).toBeDefined();
  await act(async () => choice!.click());
}

it("shows a model's settings with its defaults and keeps only what was changed", async () => {
  const changed = await renderImage({ prompt: "a knight", model: { provider: character.provider, id: "character" }, resolution: "1K", aspectRatio: "1:1", images: [] });
  expect(host.querySelector('button[aria-label="Directions: 8 directions"]')).not.toBeNull();
  expect(host.querySelector('button[aria-label="Outline: On"]')).not.toBeNull();
  // The reference slot says what the picture is for.
  expect(host.textContent).toContain("South view");
  await pick("Directions", "4 directions");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ modelParams: { directions: "4" } }));
  await pick("Outline", "Off");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ modelParams: { directions: "4", outline: false } }));
  // Going back to a default drops it, so the plugin's default keeps applying.
  await pick("Directions", "8 directions");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ modelParams: { outline: false } }));
});

it("keeps the settings another model shares when switching, and shows text settings as fields", async () => {
  const changed = await renderImage({ prompt: "grass", model: { provider: character.provider, id: "character" }, modelParams: { view: "side", directions: "4" }, resolution: "1K", aspectRatio: "1:1", images: [] });
  await pick("Image model", "Tileset");
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ model: { provider: tileset.provider, id: "tileset" }, modelParams: { view: "side" } }));
  const field = Array.from(host.querySelectorAll("label")).find((label) => label.textContent?.startsWith("Upper terrain"))!.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, "shallow water");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ modelParams: { view: "side", upper: "shallow water" } }));
});
