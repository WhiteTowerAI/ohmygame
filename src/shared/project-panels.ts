// Project panels: pages the project itself holds in `.ohmygame/panels/<name>/`,
// shown beside the chat like a plugin's panels and talking to the app through
// the same bridge. They travel with the project and its snapshots, so the
// project's agent can write and change them. They never run native code: a
// panel is a page and what the bridge lets it do. Before one runs, the person
// allows what its `panel.json` asks for, and again whenever that changes.

import type { PluginUiCapabilities } from "./plugin-ui-protocol.js";

/** The plugin id a project panel's page goes by: no installed plugin can have it, as ids have no `_`. */
export const PROJECT_PANEL_PUBLISHER = "_project";
export const PROJECT_PANEL_FILE = "panel.json";
export const PROJECT_PANEL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Most panels a project shows. */
export const PROJECT_PANELS_MAX = 12;
/** Most hosts one panel may fetch from. */
export const PROJECT_PANEL_HOSTS_MAX = 20;

export type ProjectPanelArea = "left" | "center" | "right" | "bottom";

/** What `panel.json` says, after checking. */
export interface ProjectPanelManifest {
  title: string;
  /** The page, a file in the panel's folder; `index.html` when left out. */
  entry: string;
  area: ProjectPanelArea;
  capabilities: PluginUiCapabilities;
}

/** How a project panel stands, as the app lists it. */
export interface ProjectPanelState {
  name: string;
  status: "allowed" | "needs-approval" | "invalid";
  /** What the panel asks for, which the person allows; the key changes whenever it does. */
  asks?: PluginUiCapabilities;
  key?: string;
  /** Why `panel.json` can't be used. */
  issues?: string[];
}

export function projectPanelPlugin(name: string): string {
  return `${PROJECT_PANEL_PUBLISHER}/${name}`;
}

/** The panel a project panel's plugin id names, or undefined for any other plugin. */
export function projectPanelName(plugin: string): string | undefined {
  const [publisher, name, ...rest] = plugin.split("/");
  return publisher === PROJECT_PANEL_PUBLISHER && name && !rest.length && PROJECT_PANEL_NAME.test(name) ? name : undefined;
}

const AREAS: readonly ProjectPanelArea[] = ["left", "center", "right", "bottom"];
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const ENTRY = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.html$/;

/** Checks `panel.json`; unknown keys are refused, so a typo can't quietly ask for less than meant. */
export function parseProjectPanelManifest(value: unknown): { ok: true; manifest: ProjectPanelManifest } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, issues: ["panel.json must be an object"] };
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["$schema", "title", "entry", "area", "capabilities", "net"].includes(key)) issues.push(`unknown key ${key}`);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > 60) issues.push("title is text of 1 to 60 characters");
  const entry = input.entry === undefined ? "index.html" : input.entry;
  if (typeof entry !== "string" || !ENTRY.test(entry) || entry.split("/").some((part) => part.startsWith(".")))
    issues.push("entry is an .html file in the panel's folder");
  const area = input.area === undefined ? "right" : input.area;
  if (!AREAS.includes(area as ProjectPanelArea)) issues.push(`area is one of ${AREAS.join(", ")}`);
  const capabilities: PluginUiCapabilities = {};
  const asked = input.capabilities;
  if (asked !== undefined) {
    if (!asked || typeof asked !== "object" || Array.isArray(asked)) issues.push("capabilities must be an object");
    else
      for (const [name, setting] of Object.entries(asked as Record<string, unknown>)) {
        if (name === "project.files") {
          if (setting === "read" || setting === "write") capabilities["project.files"] = setting;
          else issues.push('capabilities["project.files"] is "read" or "write"');
        } else if (name === "composer" || name === "project.selection" || name === "project.history" || name === "project.usage") {
          if (setting === true) capabilities[name] = true;
          else if (setting !== false) issues.push(`capabilities["${name}"] is true or false`);
        } else issues.push(`unknown capability ${name}`);
      }
  }
  if (input.net !== undefined) {
    const hosts = input.net;
    if (!Array.isArray(hosts) || hosts.length > PROJECT_PANEL_HOSTS_MAX || !hosts.every((host) => typeof host === "string" && HOST.test(host)))
      issues.push(`net lists at most ${PROJECT_PANEL_HOSTS_MAX} host names, such as api.example.com, in lower case`);
    else if (hosts.length) capabilities.net = [...new Set(hosts as string[])].sort();
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, manifest: { title, entry: entry as string, area: area as ProjectPanelArea, capabilities } };
}

/** The same text for the same asks, whatever order `panel.json` gave them in. */
export function projectPanelAsksText(capabilities: PluginUiCapabilities): string {
  return JSON.stringify(Object.fromEntries(Object.entries(capabilities).sort(([left], [right]) => left.localeCompare(right))));
}
