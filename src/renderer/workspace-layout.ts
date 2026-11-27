import { movePanel, type AreaId, type AreaState, type Layout } from "./panel-layout.js";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { supportsWebPreview } from "../shared/project-runtime.js";
import { t } from "./i18n.js";

// Each project keeps its own layout. A project type only names the panels it
// offers, in the order they open (the shape of a plugin's
// `projectTypes[].panels`); the host decides where they go. A project without
// a layout of its own starts from the latest one any project kept, fitted to
// its panels, so it opens the way the person last arranged things.

/** The latest layout; before projects kept their own, the one every project shared. */
const LATEST_KEY = "ohmygame-workspace-layout";
const projectKey = (projectId: string) => `${LATEST_KEY}:${projectId}`;
const VERSION = 3;
const AREAS = ["left", "center", "right", "bottom"] as const;

export type WorkspacePanel = "chat" | "game" | "design" | "code" | "assets" | "canvas" | "plugin" | "browser";
/** What a built-in panel is called, on its tab and wherever it says something about itself. */
export function panelTitle(panel: WorkspacePanel): string {
  return panel === "code" || panel === "assets" ? t(`workspace.tab.${panel}`) : t(`panels.${panel}`);
}
/** A built-in panel, or a plugin's as `plugin:<publisher/name>:<panel>`. */
export type PanelId = WorkspacePanel | `plugin:${string}`;
/** Where plugin panels open, from their manifests; built-in panels need none. */
export type PanelHomes = Readonly<Record<string, AreaId>>;
/** Plugin panels whose manifests say they open only when asked to. */
export type OnRequestPanels = ReadonlySet<PanelId>;
export type Preset = "default" | "art" | "code";

/**
 * The panels each built-in type offers. A Godot plugin will name its own.
 * Design is the game design document; Canvas is the asset canvas beside it.
 */
const TYPE_PANELS: Record<ProjectType, readonly WorkspacePanel[]> = {
  "web-game": ["chat", "game", "design", "canvas", "code", "assets"],
  general: ["chat", "game", "design", "canvas", "code", "assets"],
  "godot-game": ["chat", "game", "design", "canvas", "code", "assets"],
  "asset-canvas": ["chat", "canvas", "code"],
  // A plugin workspace: its Overview, then its files.
  plugin: ["chat", "plugin", "code"],
};

/**
 * The panels a project offers: its type's, less the game where it has no
 * preview, unless `withGame` adds it back for a General project that can
 * have one (`gamePanelAddable`).
 */
export function panelsOf(project: Pick<ProjectState, "type"> & Parameters<typeof supportsWebPreview>[0], withGame = false): WorkspacePanel[] {
  const panels = TYPE_PANELS[project.type].filter((panel) => panel !== "game" || supportsWebPreview(project) || (withGame && gamePanelAddable(project)));
  return browserAvailable() ? [...panels, "browser"] : panels;
}

/** The Browser panel shows pages in native views, which only the desktop app has. */
function browserAvailable(): boolean {
  return typeof window !== "undefined" && !!window.ohMyGameDesktop?.browser;
}

/** Panels every project offers but none opens until the person does, from a + menu or the agent. */
const OPENED_ON_REQUEST: ReadonlySet<PanelId> = new Set<PanelId>(["browser"]);
const opensOnRequest = (panel: PanelId, onRequest?: OnRequestPanels) => OPENED_ON_REQUEST.has(panel) || !!onRequest?.has(panel);

/**
 * Whether the person can add the Game panel to a project that doesn't offer
 * it: a General project with Web preview off, which the panel then says how
 * to turn on. A plugin's type whose game runs outside OhMyGame can't have one.
 */
export function gamePanelAddable(project: Pick<ProjectState, "type"> & Parameters<typeof supportsWebPreview>[0]): boolean {
  return project.type === "general" && project.pluginType?.preview !== "native" && !supportsWebPreview(project);
}

/** Where a panel opens when it isn't in the layout. */
export const homeOf = (panel: PanelId, homes?: PanelHomes): AreaId => homes?.[panel] ?? (panel === "chat" ? "left" : "center");

/** The presets that make sense for these panels: Art and Code put the canvas or the code first. */
export function presetsFor(offered: readonly PanelId[]): Preset[] {
  const code = offered.includes("code");
  return ["default", ...(code && offered.includes("canvas") ? ["art" as const] : []), ...(code ? ["code" as const] : [])];
}

const area = (panels: PanelId[], size: number): AreaState => ({ panels, active: panels[0], size });

/**
 * The chat on the left and the rest in the middle in the type's order, the
 * first in front. A project without a game opens on its
 * code. Art and Code bring the canvas or the code forward. Plugin panels
 * open in the areas their plugins name, except those that open on request.
 */
export function presetLayout(preset: Preset, allOffered: readonly PanelId[], homes?: PanelHomes, onRequest?: OnRequestPanels): Layout {
  const offered = allOffered.filter((panel) => !opensOnRequest(panel, onRequest));
  let middle = offered.filter((panel) => homeOf(panel, homes) === "center");
  // A project with nothing to play opens on its code, unless it is a canvas.
  const playable = middle.includes("game");
  const first: PanelId | undefined = preset === "art" ? "canvas" : preset === "code" || (!playable && offered.includes("design")) ? "code" : undefined;
  if (first && middle.includes(first)) middle = [first, ...middle.filter((panel) => panel !== first)];
  return {
    left: area(offered.filter((panel) => homeOf(panel, homes) === "left"), 380),
    center: area(middle, 0),
    right: area(offered.filter((panel) => homeOf(panel, homes) === "right"), 280),
    bottom: area(offered.filter((panel) => homeOf(panel, homes) === "bottom"), 240),
  };
}

/** While the project loads: the chat where it opens, and nothing in the middle yet. */
export function loadingLayout(): Layout {
  return presetLayout("default", ["chat"]);
}

/** A saved arrangement, with every panel it knew about, closed ones included. */
export interface SavedLayout {
  layout: Layout;
  known: readonly string[];
}

function readSaved(key: string): SavedLayout | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "{}") as { version?: number } & Partial<SavedLayout>;
    return saved.version === VERSION && saved.layout && validLayout(saved.layout) && Array.isArray(saved.known)
      ? { layout: saved.layout, known: saved.known }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a project's layout, and it as the latest, which projects without their own start from. */
export function saveLayout(projectId: string, saved: SavedLayout): void {
  try {
    const value = JSON.stringify({ version: VERSION, ...saved });
    localStorage.setItem(projectKey(projectId), value);
    localStorage.setItem(LATEST_KEY, value);
  } catch { /* The layout still works without storage. */ }
}

/**
 * What a project opens with: its own layout, the latest one, or the default.
 * The latest may be another type's, so each area's front tab is left to this
 * project's default.
 */
export function openingLayout(projectId: string, offered: readonly PanelId[], homes?: PanelHomes, onRequest?: OnRequestPanels): SavedLayout {
  const own = readSaved(projectKey(projectId));
  if (own) return own;
  const latest = readSaved(LATEST_KEY);
  if (latest) return { layout: Object.fromEntries(AREAS.map((id) => [id, { ...latest.layout[id], active: undefined }])) as Layout, known: latest.known };
  const layout = presetLayout("default", offered, homes, onRequest);
  // compat: since beta.5.1, remove from beta.7 and 2026-12-03. The ohmygame:chat-layout setting.
  // The chat-side setting this replaced still decides where the chat first opens.
  if (!legacyChatRight() || !layout.left.panels.includes("chat")) return { layout, known: [] };
  const moved = movePanel(layout, "chat", "right");
  return { layout: { ...moved, right: { ...moved.right, size: layout.left.size } }, known: [] };
}

function legacyChatRight(): boolean {
  try {
    return localStorage.getItem("ohmygame:chat-layout") === "right";
  } catch {
    return false;
  }
}

function validLayout(layout: Layout): boolean {
  return AREAS.every((id) => {
    const value = layout[id] as AreaState | undefined;
    return !!value && Array.isArray(value.panels) && typeof value.size === "number";
  });
}

/**
 * The saved layout with the panels this project offers. Panels it doesn't offer
 * are left out, and an area whose tab was one of them shows the default's tab.
 * A panel the saved layout never knew (one of another type, or the game once a
 * preview turns on) opens where the default puts it, unless it opens on
 * request; panels the person closed stay closed.
 */
export function fitLayout(saved: SavedLayout, offered: readonly PanelId[], fallback: Layout, onRequest?: OnRequestPanels): Layout {
  const placed = new Set<string>();
  const next = { ...saved.layout };
  for (const id of AREAS) {
    const panels = saved.layout[id].panels.filter((panel) => offered.includes(panel as PanelId) && !placed.has(panel));
    panels.forEach((panel) => placed.add(panel));
    const active = [saved.layout[id].active, fallback[id].active].find((panel) => panel && panels.includes(panel));
    next[id] = { ...saved.layout[id], panels, active };
  }
  // New panels follow the default's order.
  const order = new Set([...AREAS.flatMap((id) => fallback[id].panels as PanelId[]), ...offered]);
  for (const panel of order) {
    if (!offered.includes(panel) || placed.has(panel) || saved.known.includes(panel) || opensOnRequest(panel, onRequest)) continue;
    const home = AREAS.find((id) => fallback[id].panels.includes(panel)) ?? homeOf(panel);
    next[home] = { ...next[home], panels: [...next[home].panels, panel] };
  }
  // Where the saved layout doesn't say, the default's front tab leads.
  for (const id of AREAS) {
    const { panels, active } = next[id];
    const front = fallback[id].active && panels.includes(fallback[id].active) ? fallback[id].active : panels[0];
    next[id] = { ...next[id], active: active ?? front };
  }
  return next;
}

/** What to keep after the person changes a project's layout to `next`: it, and every panel the project has offered. */
export function keepLayout(saved: SavedLayout | undefined, next: Layout, offered: readonly PanelId[]): SavedLayout {
  return { layout: next, known: [...new Set([...(saved?.known ?? []), ...offered])] };
}
