// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance } from "../src/renderer/appearance.js";

afterEach(() => {
  delete window.ohMyGameDesktop;
});

function installDesktop() {
  const setAppearance = vi.fn(async () => {});
  Object.defineProperty(window, "ohMyGameDesktop", { configurable: true, value: { setAppearance } });
  return setAppearance;
}

it("themes the page and tells the desktop app", () => {
  const setAppearance = installDesktop();
  applyAppearance("dark");
  expect(document.documentElement.dataset.appearance).toBe("dark");
  expect(setAppearance).toHaveBeenCalledExactlyOnceWith("dark");
});

it("themes a page the desktop app should not hear from, such as a thumbnail window, without asking it", () => {
  const setAppearance = installDesktop();
  applyAppearance("light", { desktop: false });
  expect(document.documentElement.dataset.appearance).toBe("light");
  expect(setAppearance).not.toHaveBeenCalled();
});
