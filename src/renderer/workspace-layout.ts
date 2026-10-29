import { movePanel, type AreaId, type AreaState, type Layout } from "./panel-layout.js";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { supportsProjectPreview } from "../shared/project-runtime.js";

// One layout for every project. A project type only names the panels it
// offers, in the order they open (the shape of a format 2 plugin's
// `projectTypes[].panels`); the host decides where they go. The person's
// arrangement is kept once and fitted to each project's panels, so moving the
// chat to the right holds everywhere.

const STORAGE_KEY = "ohmygame-workspace-layout";
const VERSION = 2;
const AREAS = ["left", "center", "right", "bottom"] as const;

export type WorkspacePanel = "chat" | "game" | "design" | "code" | "assets" | "story" | "canvas";
export type Preset = "default" | "art" | "code";

/** The panels each built-in type offers. A Godot plugin will name its own. */
const TYPE_PANELS: Record<ProjectType, readonly WorkspacePanel[]> = {
  "web-game": ["chat", "game", "design", "code", "assets"],
  general: ["chat", "game", "design", "code", "assets"],
  "godot-game": ["chat", "game", "design", "code", "assets"],
  "interactive-story": ["chat", "story"],
  "asset-canvas": ["chat", "canvas"],
};

/** The panels a project offers: its type's, less the game where it has no preview. */
export function panelsOf(project: Pick<ProjectState, "type"> & Parameters<typeof supportsProjectPreview>[0]): WorkspacePanel[] {
  return TYPE_PANELS[project.type].filter((panel) => panel !== "game" || supportsProjectPreview(project));
}

/** Where a panel opens when it isn't in the layout. */
export const homeOf = (panel: WorkspacePanel): AreaId => panel === "chat" ? "left" : "center";

/** The presets that make sense for these panels: Art and Code put that panel first. */
export function presetsFor(offered: readonly WorkspacePanel[]): Preset[] {
  return ["default", ...(offered.includes("design") ? ["art" as const] : []), ...(offered.includes("code") ? ["code" as const] : [])];
}

const area = (panels: WorkspacePanel[], size: number): AreaState => ({ panels, active: panels[0], size });

/**
 * The chat on the left and the rest in the middle in the type's order, the
 * first in front. A project without a game opens on its code. Art and Code
 * bring the design canvas or the code forward.
 */
export function presetLayout(preset: Preset, offered: readonly WorkspacePanel[]): Layout {
  let middle = offered.filter((panel) => homeOf(panel) === "center");
  const first: WorkspacePanel | undefined = preset === "art" ? "design" : preset === "code" || !middle.includes("game") ? "code" : undefined;
  if (first && middle.includes(first)) middle = [first, ...middle.filter((panel) => panel !== first)];
  return {
    left: area(offered.filter((panel) => homeOf(panel) === "left"), 380),
    center: area(middle, 0),
    right: area([], 280),
    bottom: area([], 240),
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

export function readLayout(): SavedLayout | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { version?: number } & Partial<SavedLayout>;
    return saved.version === VERSION && saved.layout && validLayout(saved.layout) && Array.isArray(saved.known)
      ? { layout: saved.layout, known: saved.known }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(saved: SavedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...saved }));
  } catch { /* The layout still works without storage. */ }
}

/** What a project opens with: the saved arrangement, or the default. */
export function openingLayout(offered: readonly WorkspacePanel[]): SavedLayout {
  const saved = readLayout();
  if (saved) return saved;
  const layout = presetLayout("default", offered);
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
 * preview turns on) opens where the default puts it; panels the person closed
 * stay closed.
 */
export function fitLayout(saved: SavedLayout, offered: readonly WorkspacePanel[], fallback: Layout): Layout {
  const placed = new Set<string>();
  const next = { ...saved.layout };
  for (const id of AREAS) {
    const panels = saved.layout[id].panels.filter((panel) => offered.includes(panel as WorkspacePanel) && !placed.has(panel));
    panels.forEach((panel) => placed.add(panel));
    const active = [saved.layout[id].active, fallback[id].active].find((panel) => panel && panels.includes(panel));
    next[id] = { ...saved.layout[id], panels, active };
  }
  // New panels follow the default's order.
  const order = new Set([...AREAS.flatMap((id) => fallback[id].panels as WorkspacePanel[]), ...offered]);
  for (const panel of order) {
    if (!offered.includes(panel) || placed.has(panel) || saved.known.includes(panel)) continue;
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

/**
 * What to keep after the person changes a project's layout from `before` to
 * `next`: the change, with the other types' panels where they were, so a
 * story's arrangement doesn't move a game's panels. An area whose front tab
 * didn't change keeps the saved one, which may be another type's.
 */
export function mergeLayout(saved: SavedLayout | undefined, before: Layout, next: Layout, offered: readonly WorkspacePanel[]): SavedLayout {
  const layout = { ...next };
  if (saved) {
    const mine = (panel: string) => offered.includes(panel as WorkspacePanel);
    for (const id of AREAS) {
      // The saved order, with this project's panels replaced by the new ones in turn.
      const queue = [...next[id].panels];
      const panels: string[] = [];
      for (const panel of saved.layout[id].panels) {
        if (!mine(panel)) panels.push(panel);
        else if (queue.length) panels.push(queue.shift()!);
      }
      panels.push(...queue);
      const kept = saved.layout[id].active;
      const active = next[id].active === before[id].active && kept && panels.includes(kept) ? kept : next[id].active ?? panels[0];
      layout[id] = { ...next[id], panels, active };
    }
  }
  return { layout, known: [...new Set([...(saved?.known ?? []), ...offered])] };
}
