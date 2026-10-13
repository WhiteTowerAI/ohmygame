// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomModelUsageFields } from "../src/renderer/custom-model-usage-fields.js";
import { defaultImageSettings, defaultVideoSettings } from "../src/shared/custom-models.js";
import type { CustomModelUsages } from "../src/shared/contracts.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
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

describe("custom image reference settings", () => {
  it.each([
    ["gpt-image-2", undefined, 16],
    ["google/gemini-3.1-flash-image", "openrouter", 14],
    ["gemini-2.5-flash-image", "google", 3],
    ["doubao-seedream-5-0-pro-260628", "seedance", 10],
    ["doubao-seedream-5-0-260128", "seedance", 14],
    ["my-image-alias", undefined, 1],
  ] as const)("enables %s with its known reference count", async (modelId, preset, limit) => {
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={{}} modelId={modelId} preset={preset} onChange={onChange} />));
    const checkbox = [...host.querySelectorAll("label")].find((label) => label.textContent === "Image")!.querySelector("input")!;
    await act(async () => checkbox.click());
    expect(onChange).toHaveBeenCalledWith({ image: expect.objectContaining({ maxReferenceImages: limit }) });
  });

  it("preserves a saved count until the user restores the reference default", async () => {
    const usages: CustomModelUsages = { language: true, video: defaultVideoSettings(), image: {
      ...defaultImageSettings(), maxReferenceImages: 1, baseUrl: "https://relay.test/images", resolutions: ["2K"], aspectRatios: ["16:9"],
    } };
    const onChange = vi.fn();
    await act(async () => root.render(<CustomModelUsageFields usages={usages} modelId="gpt-image-2" onChange={onChange} />));
    const input = [...host.querySelectorAll("label")].find((label) => label.textContent === "Max reference images")!.querySelector("input")!;
    expect(input.value).toBe("1");
    expect(input.max).toBe("16");
    expect(onChange).not.toHaveBeenCalled();
    const restore = [...host.querySelectorAll("button")].find((button) => button.textContent === "Use model default (16 references)")!;
    await act(async () => restore.click());
    expect(onChange).toHaveBeenCalledWith({ ...usages, image: { ...usages.image, maxReferenceImages: 16 } });
  });
});
