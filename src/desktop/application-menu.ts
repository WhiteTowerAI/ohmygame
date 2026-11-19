import type { MenuItemConstructorOptions, WebContents } from "electron";

type MenuRole = NonNullable<MenuItemConstructorOptions["role"]>;

/**
 * Zooms on both forms of the key next to Backspace, shifted or not, which
 * Electron's Ctrl+Plus / Ctrl+- role accelerators only partly match: the
 * unshifted Ctrl+= zooms nothing and the shifted Ctrl+_ only Chrome does.
 * Ctrl+0 stays with the role, which it already matches.
 */
export function installZoomShortcuts(contents: WebContents): void {
  if (process.platform === "darwin") return;
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.control || input.meta || input.alt) return;
    const step = input.key === "=" || input.key === "+" ? 0.5 : input.key === "-" || input.key === "_" ? -0.5 : undefined;
    if (step === undefined || contents.isDestroyed()) return;
    event.preventDefault();
    contents.zoomLevel += step;
  });
}

export function isApplicationMenuLabels(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null &&
    Object.values(value).every((label) => typeof label === "string");
}

/**
 * Electron's default application menu with labels in the app's language. Roles
 * keep each item's action and shortcut, and a role with no label given keeps
 * Electron's English one.
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
      role: "fileMenu",
      label: labels.file,
      submenu: [mac ? item("close", "closeMac") : item("quit")],
    },
    {
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

/** What a right-click in the app window is about. */
export type WindowContextMenuParams = {
  linkURL: string;
  isEditable: boolean;
  selectionText: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
};

/**
 * The menu a right-click opens where the page shows none of its own: the edit
 * actions for text, and opening or copying a web or email link. A page area
 * with its own menu prevents the event, and Electron then asks for none.
 */
export function windowContextMenuTemplate(
  params: WindowContextMenuParams,
  labels: Record<string, string>,
  actions: { openLink: (url: string) => void; copy: (text: string) => void },
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL && isExternalLink(params.linkURL)) {
    items.push(
      { label: labels.openLink ?? "Open Link", click: () => actions.openLink(params.linkURL) },
      { label: labels.copyLink ?? "Copy Link", click: () => actions.copy(params.linkURL) },
    );
  }
  const edit: MenuItemConstructorOptions[] = params.isEditable
    ? [
        { role: "cut", label: labels.cut, enabled: params.editFlags.canCut },
        { role: "copy", label: labels.copy, enabled: params.editFlags.canCopy },
        { role: "paste", label: labels.paste, enabled: params.editFlags.canPaste },
        { type: "separator" },
        { role: "selectAll", label: labels.selectall, enabled: params.editFlags.canSelectAll },
      ]
    : params.selectionText.trim()
      ? [{ role: "copy", label: labels.copy }]
      : [];
  if (items.length && edit.length) items.push({ type: "separator" });
  return [...items, ...edit];
}

function isExternalLink(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}
