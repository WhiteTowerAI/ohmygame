import { movePanel, type AreaState, type Layout } from "./panel-layout.js";
import type { ProjectState } from "../shared/contracts.js";
import { buildsWebPreview, supportsProjectPreview } from "../shared/project-runtime.js";

// What a project's workspace holds depends on its type. Each kind offers its
// panels and presets and opens with its default; the person's arrangement is
// kept per kind, across the projects of that kind. A preset replaces it in one
// step.

const STORAGE_KEY = "ohmygame-workspace-layout";
const VERSION = 1;

/**
 * The kinds of workspace, from the project type:
 * - game: web games and general projects. The game, its design canvas, code and assets.
 * - engine: Godot without a web build. The agent does the work; design, code and assets are there to look in.
 * - story: interactive stories, in the story editor.
 * - canvas: asset canvas projects.
 */
export type WorkspaceKind = "game" | "engine" | "story" | "canvas";

export function workspaceKind(project: Pick<ProjectState, "type"> & Parameters<typeof buildsWebPreview>[0]): WorkspaceKind {
  if (project.type === "interactive-story") return "story";
  if (project.type === "asset-canvas") return "canvas";
  if (project.type === "godot-game" && !buildsWebPreview(project)) return "engine";
  return "game";
}

export type WorkspacePanel = "chat" | "game" | "design" | "code" | "assets" | "story" | "canvas";
export type Preset = "default" | "art" | "code";

const KINDS: Record<WorkspaceKind, { panels: readonly WorkspacePanel[]; presets: readonly Preset[] }> = {
  game: { panels: ["chat", "game", "design", "code", "assets"], presets: ["default", "art", "code"] },
  engine: { panels: ["chat", "design", "code", "assets"], presets: ["default", "code"] },
  story: { panels: ["chat", "story"], presets: ["default"] },
  canvas: { panels: ["chat", "canvas"], presets: ["default"] },
};

/** The panels a project offers: its kind's, less the game where it has no preview. */
export function panelsOf(project: Parameters<typeof supportsProjectPreview>[0] & Parameters<typeof workspaceKind>[0]): WorkspacePanel[] {
  return KINDS[workspaceKind(project)].panels.filter((panel) => panel !== "game" || supportsProjectPreview(project));
}

export const presetsOf = (kind: WorkspaceKind): readonly Preset[] => KINDS[kind].presets;

const area = (panels: WorkspacePanel[], size: number): AreaState => ({ panels, active: panels[0], size });

/**
 * Every preset but an engine's starts with the chat on the left; dragging it
 * elsewhere is remembered with the rest of the layout. Default: the chat
 * beside the project. Art: the design canvas first. Code: the code first. An
 * engine project is the conversation itself, in the middle, with its files
 * beside it. A game without a preview opens on its code.
 */
export function presetLayout(kind: WorkspaceKind, preset: Preset, offered?: readonly WorkspacePanel[]): Layout {
  const left = area(["chat"], 380);
  const right = area([], 280);
  const bottom = area([], 240);
  if (kind === "engine") {
    return preset === "code"
      ? { left, right, center: area(["code", "design", "assets"], 0), bottom }
      : { left: area([], 380), right, center: area(["chat", "design", "code", "assets"], 0), bottom };
  }
  if (kind === "story") return { left, right, center: area(["story"], 0), bottom };
  if (kind === "canvas") return { left, right, center: area(["canvas"], 0), bottom };
  if (preset === "art") return { left, right, center: area(["design", "game", "code", "assets"], 0), bottom };
  if (preset === "code") return { left, right, center: area(["code", "game", "design", "assets"], 0), bottom };
  if (offered && !offered.includes("game")) return { left, right, center: area(["code", "design", "assets"], 0), bottom };
  return { left, right, center: area(["game", "design", "code", "assets"], 0), bottom };
}

/** While the project loads: the chat where it opens, and nothing in the middle yet. */
export function loadingLayout(): Layout {
  return { ...presetLayout("game", "default"), center: area([], 0) };
}

const keyOf = (kind: WorkspaceKind) => `${STORAGE_KEY}.${kind}`;

/** A saved arrangement, with every panel it knew about, closed ones included. */
export interface SavedLayout {
  layout: Layout;
  known: readonly string[];
}

export function readLayout(kind: WorkspaceKind): SavedLayout | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(keyOf(kind)) ?? "{}") as { version?: number } & Partial<SavedLayout>;
    return saved.version === VERSION && saved.layout && validLayout(saved.layout) && Array.isArray(saved.known)
      ? { layout: saved.layout, known: saved.known }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveLayout(kind: WorkspaceKind, saved: SavedLayout): void {
  try {
    localStorage.setItem(keyOf(kind), JSON.stringify({ version: VERSION, ...saved }));
  } catch { /* The layout still works without storage. */ }
}

/** What a project of this kind opens with: the saved arrangement, or the default. */
export function openingLayout(kind: WorkspaceKind, offered: readonly WorkspacePanel[]): SavedLayout {
  const saved = readLayout(kind);
  if (saved) return saved;
  const layout = presetLayout(kind, "default", offered);
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

const AREAS = ["left", "center", "right", "bottom"] as const;

/**
 * A saved layout with the panels this project offers. Panels it doesn't offer
 * are dropped, and an area whose tab was one of them shows the default's tab.
 * A panel the saved layout never knew (a newer panel, or the game once a
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
    next[id] = { ...saved.layout[id], panels, active: active ?? panels[0] };
  }
  for (const panel of offered) {
    if (placed.has(panel) || saved.known.includes(panel)) continue;
    const home = AREAS.find((id) => fallback[id].panels.includes(panel)) ?? "center";
    next[home] = { ...next[home], panels: [...next[home].panels, panel], active: next[home].active ?? panel };
  }
  return next;
}
