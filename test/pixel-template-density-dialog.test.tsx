// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PixelTemplateDensityDialog } from "../src/renderer/pixel-template-density-dialog.js";
import { setTemplateExampleStore } from "../src/renderer/template-example-cache.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(onConfirm = vi.fn(), onClose = vi.fn()) {
  await act(async () => root.render(<PixelTemplateDensityDialog category="creatures" returnFocus={null} onClose={onClose} onConfirm={onConfirm} />));
  return { onConfirm, onClose };
}

it("offers the three densities with category previews and remembers the last choice", async () => {
  const { onConfirm } = await open();
  const options = [...container.querySelectorAll<HTMLInputElement>('input[name="pixel-template-density"]')];
  expect(options.map((input) => input.value)).toEqual(["coarse", "classic", "detailed"]);
  expect(options.find((input) => input.checked)?.value).toBe("classic");
  expect(container.querySelectorAll(".pixel-template-density-preview img")).toHaveLength(3);
  expect(container.textContent).toContain("Create Creatures template");

  await act(async () => options[0]!.click());
  await act(async () => container.querySelector<HTMLButtonElement>(".project-create-submit")!.click());
  expect(onConfirm).toHaveBeenCalledWith("coarse");

  await act(async () => root.unmount());
  root = createRoot(container);
  await open();
  expect(container.querySelector<HTMLInputElement>('input[name="pixel-template-density"]:checked')?.value).toBe("coarse");
});

it("closes on Escape without creating a template", async () => {
  const { onConfirm, onClose } = await open();
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

it("shows the copy kept on this device when a preview cannot be loaded", async () => {
  const saved = new Map<string, Blob>();
  setTemplateExampleStore({ get: async (url) => saved.get(url), put: async (url, image) => { saved.set(url, image); } });
  try {
    await open();
    const preview = document.querySelector<HTMLImageElement>(".pixel-template-density-preview img")!;
    const url = preview.getAttribute("src")!;
    expect(url).toMatch(/^https:\/\/assets\.ohmygame\.ai\/template-examples\//);
    saved.set(url, new Blob(["pixels"], { type: "image/webp" }));
    await act(async () => {
      preview.dispatchEvent(new Event("error"));
      await Promise.resolve();
    });
    expect(document.querySelector<HTMLImageElement>(".pixel-template-density-preview img")!.getAttribute("src")).toMatch(/^blob:/);
  } finally {
    setTemplateExampleStore({ get: async () => undefined, put: async () => undefined });
  }
});
