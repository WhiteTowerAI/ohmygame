import type { MenuItemConstructorOptions } from "electron";

type MenuRole = NonNullable<MenuItemConstructorOptions["role"]>;

export function isApplicationMenuLabels(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null &&
    Object.values(value).every((label) => typeof label === "string");
}

/**
 * Electron's default application menu with labels in the app's language. Roles
 * keep each item's action and shortcut, and a role with no label given keeps
 * Electron's English one. The ids name the menus the Windows title bar opens.
 */
export function applicationMenuTemplate(
  labels: Record<string, string>,
  platform: NodeJS.Platform,
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const item = (role: MenuRole, key: string = role.toLowerCase()): MenuItemConstructorOptions =>
    ({ role, label: labels[key] });
  const separator: MenuItemConstructorOptions = { type: "separator" };
  return [
    ...(mac
      ? [{
          role: "appMenu",
          submenu: [
            item("about"),
            separator,
            item("services"),
            separator,
            item("hide"),
            item("hideOthers"),
            item("unhide"),
            separator,
            item("quit", "quitMac"),
          ],
        } satisfies MenuItemConstructorOptions]
      : []),
    {
      id: "File",
      role: "fileMenu",
      label: labels.file,
      submenu: [mac ? item("close", "closeMac") : item("quit")],
    },
    {
      id: "Edit",
      role: "editMenu",
      label: labels.edit,
      submenu: [
        item("undo"),
        item("redo"),
        separator,
        item("cut"),
        item("copy"),
        item("paste"),
        ...(mac
          ? [
              item("pasteAndMatchStyle"),
              item("delete"),
              item("selectAll"),
              separator,
              {
                label: labels.substitutions ?? "Substitutions",
                submenu: [
                  item("showSubstitutions"),
                  separator,
                  item("toggleSmartQuotes"),
                  item("toggleSmartDashes"),
                  item("toggleTextReplacement"),
                ],
              },
              {
                label: labels.speech ?? "Speech",
                submenu: [item("startSpeaking"), item("stopSpeaking")],
              },
            ]
          : [item("delete"), separator, item("selectAll")]),
      ],
    },
    {
      id: "View",
      role: "viewMenu",
      label: labels.view,
      submenu: [
        item("reload"),
        item("forceReload"),
        item("toggleDevTools"),
        separator,
        item("resetZoom"),
        item("zoomIn"),
        item("zoomOut"),
        separator,
        item("togglefullscreen"),
      ],
    },
    {
      id: "Window",
      role: "windowMenu",
      label: labels.window,
      submenu: [
        item("minimize"),
        item("zoom"),
        ...(mac ? [separator, item("front")] : [item("close")]),
      ],
    },
  ];
}
