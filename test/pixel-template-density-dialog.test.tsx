// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PixelTemplateDensityDialog } from "../src/renderer/pixel-template-density-dialog.js";

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
