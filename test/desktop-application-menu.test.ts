import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { applicationMenuTemplate, isApplicationMenuLabels, windowContextMenuTemplate, type WindowContextMenuParams } from "../src/desktop/application-menu.js";
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

  it("accepts only a record of strings as labels", () => {
    expect(isApplicationMenuLabels({ undo: "撤销" })).toBe(true);
    expect(isApplicationMenuLabels(undefined)).toBe(false);
    expect(isApplicationMenuLabels(null)).toBe(false);
    expect(isApplicationMenuLabels({ undo: 1 })).toBe(false);
  });
});

describe("window context menu", () => {
  const params = (overrides: Partial<WindowContextMenuParams>): WindowContextMenuParams => ({
    linkURL: "",
    isEditable: false,
    selectionText: "",
    editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
    ...overrides,
  });
  const actions = () => ({ openLink: vi.fn(), copy: vi.fn() });

  it("opens nothing where there is nothing to act on", () => {
    expect(windowContextMenuTemplate(params({}), {}, actions())).toEqual([]);
    expect(windowContextMenuTemplate(params({ linkURL: "javascript:alert(1)" }), {}, actions())).toEqual([]);
  });

  it("opens and copies a web or email link, then copies selected text", () => {
    const handlers = actions();
    const items = windowContextMenuTemplate(params({ linkURL: "https://example.com/", selectionText: "example" }), zhCN.windowMenu, handlers);
    expect(items.map((item) => item.label ?? item.type)).toEqual(["打开链接", "复制链接", "separator", "复制"]);
    (items[0]!.click as () => void)();
    (items[1]!.click as () => void)();
    expect(handlers.openLink).toHaveBeenCalledWith("https://example.com/");
    expect(handlers.copy).toHaveBeenCalledWith("https://example.com/");
    expect(windowContextMenuTemplate(params({ linkURL: "mailto:hi@example.com" }), en.windowMenu, actions()).map((item) => item.label))
      .toEqual(["Open Link", "Copy Link"]);
  });

  it("offers the edit actions in a text field, as far as they apply", () => {
    const items = windowContextMenuTemplate(params({ isEditable: true }), en.windowMenu, actions());
    expect(items.map((item) => item.role ?? item.type)).toEqual(["cut", "copy", "paste", "separator", "selectAll"]);
    expect(items[0]!.enabled).toBe(false);
    expect(items.every((item) => item.type === "separator" || item.label)).toBe(true);
  });
});
