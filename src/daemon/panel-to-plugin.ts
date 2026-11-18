import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_HOST_API_VERSION, PERSONAL_PUBLISHER } from "../shared/plugin-manifest.js";
import type { ProjectPanelManifest } from "../shared/project-panels.js";

// A project's own panel made into a plugin, for every project to use: its
// folder becomes the plugin's `ui/` and its `panel.json` the plugin's
// manifest, by fixed rules, so the Plugin Builder starts from a package that
// already passes its checks. What a plugin page can't do the same way, such
// as reaching the network, is left for the workspace's agent, which the
// request it gets says.

/** The panel's file, which the manifest replaces. */
const PANEL_FILE = "panel.json";

/** A plain tile, so a panel's plugin has the icon its tab needs until the agent draws a better one. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f5bd5"/><rect x="14" y="16" width="36" height="32" rx="5" fill="none" stroke="#ffffff" stroke-width="4"/><path d="M14 26h36" stroke="#ffffff" stroke-width="4"/></svg>
`;

/** The first `personal/<name>` id that `taken` says is free: the panel's name, then with a number. */
export function panelPluginId(name: string, taken: (id: string) => boolean): string {
  for (let index = 1; ; index += 1) {
    const id = `${PERSONAL_PUBLISHER}/${index === 1 ? name : `${name}-${index}`}`;
    if (!taken(id)) return id;
  }
}

/** The manifest of a panel's plugin; a panel asks for what its page does, and a plugin page can do all of it but `net`. */
export function panelPluginManifest(id: string, name: string, panel: ProjectPanelManifest): Record<string, unknown> {
  const { net: _net, ...capabilities } = panel.capabilities;
  return {
    id,
    version: "0.1.0",
    engines: { "ohmygame-api": `^${PLUGIN_HOST_API_VERSION}` },
    displayName: panel.title,
    description: `The ${panel.title} panel, for every project.`,
    icon: "./assets/icon.svg",
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    contributes: {
      panels: [{ id: name, title: panel.title, area: panel.area, entry: `./ui/${panel.entry}` }],
      commands: [{ id: "open", title: `Open ${panel.title}`, slots: [{ slot: "project.menu" }], run: { openPanel: name } }],
    },
  };
}

/**
 * Writes the plugin of the panel in `panelFolder` to `root`: the panel's
 * files in `ui/`, without its `panel.json`, a manifest and a plain icon.
 */
export async function writePanelPlugin(root: string, panelFolder: string, id: string, name: string, panel: ProjectPanelManifest): Promise<void> {
  await mkdir(path.join(root, ".ohmygame-plugin"), { recursive: true });
  await mkdir(path.join(root, "assets"), { recursive: true });
  // Links are left behind: its page never followed them, and a package can't hold one.
  await cp(panelFolder, path.join(root, "ui"), {
    recursive: true,
    filter: async (source) => path.relative(panelFolder, source) !== PANEL_FILE && !(await lstat(source)).isSymbolicLink(),
  });
  await writeFile(path.join(root, "assets/icon.svg"), ICON);
  await writeFile(path.join(root, ".ohmygame-plugin/plugin.json"), `${JSON.stringify(panelPluginManifest(id, name, panel), null, 2)}\n`);
}

/** What the workspace's agent is asked to do with the plugin a panel became; in English, as all text sent to the agent. */
export function panelPluginPrompt(folder: string, panel: ProjectPanelManifest): string {
  return [
    `This plugin was made from the project panel "${panel.title}": its page is in ${folder}/ui/ and the manifest says what it asked for.`,
    "Read it, give the plugin a description and an icon that fit, check it with plugin_manage prepare and look at it in the preview.",
    ...(panel.capabilities.net?.length
      ? [`As a panel it fetched from ${panel.capabilities.net.join(", ")}, which a plugin page can't do: move those requests into native code the page runs as a command, with the hosts in capabilities.network.`]
      : []),
    "Then say what changed and what I should check.",
  ].join(" ");
}
