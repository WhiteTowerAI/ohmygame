// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectActivitySnapshot, ProjectAgentActivity, ProjectState } from "../src/shared/contracts.js";

let activity: ProjectAgentActivity[] = [];
let names: ProjectActivitySnapshot["names"] = [];
// Each stream starts with the current snapshot, as the daemon's does; push() sends a change to every open stream.
const streams = new Set<{ signal: AbortSignal; onSnapshot: (snapshot: ProjectActivitySnapshot) => void }>();
const streamActivity = vi.fn(async (signal: AbortSignal, onSnapshot: (snapshot: ProjectActivitySnapshot) => void) => {
  const stream = { signal, onSnapshot };
  streams.add(stream);
  onSnapshot({ activity, names });
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  streams.delete(stream);
});
const listProjects = vi.fn<() => Promise<ProjectState[]>>();
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects,
  streamProjectActivity: streamActivity,
  waitForRuntime: async () => undefined,
  getProjectCover: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/app-sidebar.tsx"), () => ({ AppSidebar: () => null }));
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({ ProjectPromptCreator: () => null }));
vi.doMock(path.resolve("src/renderer/examples.tsx"), () => ({
  useExamples: () => ({ examples: [], covers: {} }),
  ExampleShelf: () => null,
}));
vi.doMock(path.resolve("src/renderer/asset-canvas-quick-start.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/asset-canvas-quick-start.js")>()),
  loadQuickStartModels: async () => undefined,
}));
const { Home } = await import("../src/renderer/home.js");
const { ProjectsPage } = await import("../src/renderer/projects.js");
const { GameStudioHome } = await import("../src/renderer/game-studio-home.js");
const { AssetCanvasHome } = await import("../src/renderer/asset-canvas-home.js");
const { useProjectActivity } = await import("../src/renderer/use-project-activity.js");
const { runtimeConnection, updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let snapshot: ReturnType<typeof useProjectActivity>;
function Activity({ enabled = true }: { enabled?: boolean }) {
  snapshot = useProjectActivity(enabled);
  return null;
}
const noop = () => undefined;
const pages = [
  { name: "Home", type: "web-game", view: <Home onNavigate={noop} onCreate={noop} onOpen={noop} /> },
  { name: "Projects", type: "web-game", view: <ProjectsPage onNavigate={noop} onOpenProject={noop} onFiltersChange={noop} /> },
  { name: "Game Studio", type: "web-game", view: <GameStudioHome projectType="web-game" onNavigate={noop} onCreate={noop} onOpenProject={noop} /> },
  { name: "Asset Canvas", type: "asset-canvas", view: <AssetCanvasHome onNavigate={noop} onOpenProject={noop} /> },
] as const;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  activity = [];
  names = [];
  streamActivity.mockClear();
  streams.clear();
  listProjects.mockReset().mockResolvedValue([]);
  updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: false });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const push = () => act(async () => {
  for (const stream of streams) stream.onSnapshot({ activity, names });
  await vi.advanceTimersByTimeAsync(2_000);
});

describe("project activity on project lists", () => {
  it.each(pages)("refreshes a generated name on $name without changing the cover", async ({ type, view }) => {
    const initial = { ...project("active", type), nameSource: "default" as const };
    listProjects.mockResolvedValue([initial]);
    await act(async () => root.render(view));
    const cover = container.querySelector(".project-card-preview")!.innerHTML;
    names = [{ ...initial, name: "Moon Garden", nameSource: "ai" }];
    await push();
    expect(container.querySelector(".project-card-name")?.textContent).toBe("Moon Garden");
    expect(container.querySelector(".project-card-preview")!.innerHTML).toBe(cover);
    const calls = listProjects.mock.calls.length;
    await push();
    expect(listProjects).toHaveBeenCalledTimes(calls);
  });
  it("receives a name after a short turn without extra project requests", async () => {
    const initial = { ...project("active", "web-game"), nameSource: "default" as const };
    listProjects.mockResolvedValue([initial]);
    await act(async () => root.render(pages[1].view));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    const calls = listProjects.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(listProjects).toHaveBeenCalledTimes(calls);
    names = [{ ...initial, name: "Moon Garden", nameSource: "ai" }];
    await push();
    expect(container.querySelector(".project-card-name")?.textContent).toBe("Moon Garden");
    expect(listProjects).toHaveBeenCalledTimes(calls);
  });
  it.each(pages)("updates Working, Stopping and idle cards on $name", async ({ type, view }) => {
    listProjects.mockResolvedValue([project("active", type), project("idle", type)]);
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => root.render(view));
    const active = container.querySelector('[aria-label="Open active"]')!;
    const idle = container.querySelector('[aria-label="Open idle"]')!;
    expect(active.querySelector('[role="status"]')?.textContent).toBe("Working");
    expect(idle.querySelector('[role="status"]')).toBeNull();
    expect(idle.querySelector(".project-card-time")).not.toBeNull();

    activity = [{ projectId: "active", status: "cancelling" }];
    await push();
    expect(active.querySelector('[role="status"]')?.textContent).toBe("Stopping");
    activity = [];
    await push();
    expect(active.querySelector('[role="status"]')).toBeNull();
    expect(active.querySelector(".project-card-time")).not.toBeNull();
  });

  it.each(pages)("opens no activity stream when $name has no projects", async ({ view }) => {
    await act(async () => root.render(view));
    await push();
    expect(container.querySelector(".project-card-open")).toBeNull();
    expect(streamActivity).not.toHaveBeenCalled();
  });
});

describe("project activity stream", () => {
  it("opens one stream and ignores what arrives after unmount", async () => {
    await act(async () => root.render(<Activity />));
    await push();
    expect(streamActivity).toHaveBeenCalledTimes(1);
    const { signal, onSnapshot } = [...streams][0]!;
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    const previous = snapshot;
    await act(async () => onSnapshot({ activity: [{ projectId: "late", status: "running" }], names: [] }));
    expect(snapshot).toBe(previous);
  });

  it("keeps the last status between snapshots and clears it when activity ends", async () => {
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => root.render(<Activity />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(snapshot.get("active")).toBe("running");
    activity = [];
    await push();
    expect(snapshot.size).toBe(0);
  });

  it("waits for project loading before opening the stream", async () => {
    await act(async () => root.render(<Activity enabled={false} />));
    await push();
    expect(streamActivity).not.toHaveBeenCalled();
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => root.render(<Activity />));
    expect(streamActivity).toHaveBeenCalledTimes(1);
    expect(snapshot.get("active")).toBe("running");
  });

  it("retains the same snapshot when status responses only change order", async () => {
    activity = [{ projectId: "one", status: "running" }, { projectId: "two", status: "cancelling" }];
    await act(async () => root.render(<Activity />));
    const previous = snapshot;
    activity = [...activity].reverse();
    await push();
    expect(snapshot).toBe(previous);
  });
});

function project(id: string, type: ProjectState["type"]): ProjectState {
  return { id, name: id, type, updatedAt: "2026-10-12T00:00:00Z", workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
