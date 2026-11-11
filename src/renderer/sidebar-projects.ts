import { useSyncExternalStore } from "react";
import type { ProjectState } from "../shared/contracts.js";

const STORE_KEY = "ohmygame-sidebar-projects";
const STORE_VERSION = 1;

export const PROJECT_COUNTS = [5, 8, 12] as const;
export type VisibleProjects = (typeof PROJECT_COUNTS)[number] | "all";
const DEFAULT_VISIBLE: VisibleProjects = 8;

interface SidebarProjects {
  /** Every project, in the person's order. */
  projects: readonly ProjectState[];
  order: readonly string[];
  visible: VisibleProjects;
  /** False when the saved list is damaged or from a newer version, which is left as it is. */
  writable: boolean;
}

// Read on first use: node tests import this module without a browser.
let state: SidebarProjects | undefined;
const listeners = new Set<() => void>();

function isVisible(value: unknown): value is VisibleProjects {
  return value === "all" || PROJECT_COUNTS.includes(value as (typeof PROJECT_COUNTS)[number]);
}

function load(): SidebarProjects {
  const empty = { projects: [], order: [], visible: DEFAULT_VISIBLE };
  const saved = localStorage.getItem(STORE_KEY);
  if (saved === null) return { ...empty, writable: true };
  try {
    const parsed = JSON.parse(saved) as { version?: unknown; order?: unknown; visible?: unknown } | null;
    if (parsed?.version === STORE_VERSION && Array.isArray(parsed.order) && parsed.order.every((id) => typeof id === "string")) {
      return { ...empty, order: parsed.order as string[], visible: isVisible(parsed.visible) ? parsed.visible : DEFAULT_VISIBLE, writable: true };
    }
  } catch {
    // Damaged: handled below, like a newer version.
  }
  return { ...empty, writable: false };
}

function read(): SidebarProjects {
  state ??= load();
  return state;
}

function update(change: Partial<SidebarProjects>): void {
  state = { ...read(), ...change };
  if (state.writable) {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: STORE_VERSION, order: state.order, visible: state.visible }));
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarProjectList(): SidebarProjects {
  return useSyncExternalStore(subscribe, read, read);
}

/** Lists `projects` in the order of `ids`, leaving out ids with no project. */
function applyOrder(ids: Iterable<string>, projects: readonly ProjectState[]): void {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const listed = [...ids].flatMap((id) => byId.get(id) ?? []);
  update({ projects: listed, order: listed.map((project) => project.id) });
}

/**
 * Takes the full project list. Editing a project never moves it; a project the
 * list hasn't seen goes first, newest first, which also seeds the first order.
 */
export function publishSidebarProjects(projects: readonly ProjectState[]): void {
  const { order } = read();
  const seen = new Set(order);
  const fresh = projects.filter((project) => !seen.has(project.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  applyOrder([...fresh.map((project) => project.id), ...order], projects);
}

/** Shows a project's new name or cover in the list without asking again. */
export function refreshSidebarProject(project: ProjectState): void {
  const { projects } = read();
  if (!projects.some((item) => item.id === project.id)) return;
  update({ projects: projects.map((item) => (item.id === project.id ? project : item)) });
}

export function setVisibleProjects(visible: VisibleProjects): void {
  update({ visible });
}

export function shownProjects<T>(items: readonly T[], visible: VisibleProjects): readonly T[] {
  return visible === "all" ? items : items.slice(0, visible);
}

/**
 * Moves `id` in front of `before` among the shown projects, or after them when
 * `before` is null. An open project shown past the count keeps its place in the
 * order unless it is the one being moved.
 */
export function moveSidebarProject(shown: readonly string[], id: string, before: string | null): void {
  const { order, projects, visible } = read();
  const listed = new Set(shownProjects(order, visible));
  const rest = shown.filter((item) => item !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  const moved = [...rest.slice(0, at), id, ...rest.slice(at)].filter((item) => item === id || listed.has(item));
  applyOrder(new Set([...moved, ...order]), projects);
}
