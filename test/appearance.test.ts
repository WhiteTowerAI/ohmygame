// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { applyAppearance, readPalette, readPluginTheme, setPalette, setPluginTheme, syncPluginTheme } from "../src/renderer/appearance.js";
import type { PluginTheme } from "../src/shared/plugins.js";

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

it("puts a plugin's theme over the neutral greys for the appearances it covers, until a palette takes its place", async () => {
  const ocean: PluginTheme = {
    id: "acme/ocean:deep", plugin: "acme/ocean", title: "Deep",
    dark: { "--gray-0": "#001020", "--color-accent": "#00aaff", "--color-app": "red", "--hue-doc": "#88aaff" },
  };
  setPalette("warm");
  setPluginTheme(ocean);
  expect(readPalette()).toBe("neutral");
  expect(document.documentElement.dataset.palette).toBeUndefined();
  const rules = () => [...(document.getElementById("ohmygame-plugin-theme") as HTMLStyleElement | null)?.sheet?.cssRules ?? []] as CSSStyleRule[];
  expect(rules().map((rule) => rule.selectorText)).toEqual([':root[data-appearance="dark"], :root[data-appearance="dark"] .workspace-code']);
  const rule = rules()[0]!;
  expect(rule.style.getPropertyValue("--gray-0")).toBe("#001020");
  expect(rule.style.getPropertyValue("--hue-doc")).toBe("#88aaff");
  // Only theme tokens: the roles built on them stay the app's.
  expect(rule.style.getPropertyValue("--color-app")).toBe("");

  // Updated with its plugin, gone with it.
  const brighter = { ...ocean, dark: { "--gray-0": "#002040" } };
  await syncPluginTheme(async () => [brighter]);
  expect(readPluginTheme()).toEqual(brighter);
  expect(rules()[0]!.style.getPropertyValue("--gray-0")).toBe("#002040");
  await syncPluginTheme(async () => { throw new Error("offline"); });
  expect(readPluginTheme()).toEqual(brighter);
  await syncPluginTheme(async () => []);
  expect(readPluginTheme()).toBeUndefined();
  expect(rules()).toEqual([]);

  setPluginTheme(ocean);
  setPalette("contrast");
  expect(readPluginTheme()).toBeUndefined();
  expect(document.getElementById("ohmygame-plugin-theme")).toBeNull();
  expect(document.documentElement.dataset.palette).toBe("contrast");

  // A palette chosen while the plugin's themes load stays.
  setPluginTheme(ocean);
  const slow = syncPluginTheme(async () => { setPalette("warm"); return [brighter]; });
  await slow;
  expect(readPluginTheme()).toBeUndefined();
  expect(readPalette()).toBe("warm");
});
