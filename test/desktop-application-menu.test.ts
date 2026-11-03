import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";
import { applicationMenuTemplate, isApplicationMenuLabels } from "../src/desktop/application-menu.js";
import en from "../src/renderer/locales/en.js";
import zhCN from "../src/renderer/locales/zh-CN.js";

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...flatten((item.submenu ?? []) as MenuItemConstructorOptions[])]);
}

function roles(items: MenuItemConstructorOptions[]): unknown[] {
  return items.map((item) => item.submenu
    ? [item.role ?? item.label, roles(item.submenu as MenuItemConstructorOptions[])]
    : item.role ?? item.type);
}

describe("application menu", () => {
  // These mirror Electron's default menus, which they replace.
  it("keeps Electron's Windows menu", () => {
    expect(roles(applicationMenuTemplate({}, "win32"))).toEqual([
      ["fileMenu", ["quit"]],
      ["editMenu", ["undo", "redo", "separator", "cut", "copy", "paste", "delete", "separator", "selectAll"]],
      ["viewMenu", ["reload", "forceReload", "toggleDevTools", "separator", "resetZoom", "zoomIn", "zoomOut", "separator", "togglefullscreen"]],
      ["windowMenu", ["minimize", "zoom", "close"]],
    ]);
  });

  it("keeps Electron's macOS menu", () => {
    expect(roles(applicationMenuTemplate({}, "darwin"))).toEqual([
      ["appMenu", ["about", "separator", "services", "separator", "hide", "hideOthers", "unhide", "separator", "quit"]],
      ["fileMenu", ["close"]],
      ["editMenu", [
        "undo", "redo", "separator", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "separator",
        ["Substitutions", ["showSubstitutions", "separator", "toggleSmartQuotes", "toggleSmartDashes", "toggleTextReplacement"]],
        ["Speech", ["startSpeaking", "stopSpeaking"]],
      ]],
      ["viewMenu", ["reload", "forceReload", "toggleDevTools", "separator", "resetZoom", "zoomIn", "zoomOut", "separator", "togglefullscreen"]],
      ["windowMenu", ["minimize", "zoom", "separator", "front"]],
    ]);
  });

  it.each(["win32", "darwin"] as const)("labels every %s item in both languages", (platform) => {
    for (const labels of [en.windowMenu, zhCN.windowMenu]) {
      const unlabelled = flatten(applicationMenuTemplate(labels, platform))
        .filter((item) => item.type !== "separator" && item.role !== "appMenu" && !item.label);
      expect(unlabelled).toEqual([]);
    }
  });

  it("uses each platform's wording for quit and close", () => {
    const labelsOf = (platform: NodeJS.Platform) => flatten(applicationMenuTemplate(zhCN.windowMenu, platform))
      .filter((item) => item.role === "quit" || item.role === "close")
      .map((item) => item.label);
    expect(labelsOf("win32")).toEqual(["退出", "关闭"]);
    expect(labelsOf("darwin")).toEqual(["退出 OhMyGame", "关闭窗口"]);
  });

  it("gives the application menu's items ids that hold in every language", () => {
    const ids = (labels: Record<string, string>) => applicationMenuTemplate(labels, "win32").map((item) => item.id);
    expect(ids(zhCN.windowMenu)).toEqual(["File", "Edit", "View", "Window"]);
    expect(ids({})).toEqual(["File", "Edit", "View", "Window"]);
  });

  it("accepts only a record of strings as labels", () => {
    expect(isApplicationMenuLabels({ undo: "撤销" })).toBe(true);
    expect(isApplicationMenuLabels(undefined)).toBe(false);
    expect(isApplicationMenuLabels(null)).toBe(false);
    expect(isApplicationMenuLabels({ undo: 1 })).toBe(false);
  });
});
