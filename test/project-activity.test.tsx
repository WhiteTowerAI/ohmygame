// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectAgentActivity, ProjectState } from "../src/shared/contracts.js";

let activity: ProjectAgentActivity[] = [];
const listActivity = vi.fn(async (_signal?: AbortSignal) => activity);
const listProjects = vi.fn<() => Promise<ProjectState[]>>();
vi.doMock(path.resolve("src/renderer/api.ts"), async original => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects,
  listProjectActivity: listActivity,
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
  { name: "Projects", type: "web-game", view: <ProjectsPage onNavigate={noop} onOpenProject={noop} /> },
  { name: "Game Studio", type: "web-game", view: <GameStudioHome projectType="web-game" onNavigate={noop} onCreate={noop} onOpenProject={noop} /> },
  { name: "Asset Canvas", type: "asset-canvas", view: <AssetCanvasHome onNavigate={noop} onOpenProject={noop} /> },
] as const;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  activity = [];
  listActivity.mockReset().mockImplementation(async () => activity);
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
const tick = () => act(async () => vi.advanceTimersByTimeAsync(2_000));

describe("project activity on project lists", () => {
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
    await tick();
    expect(active.querySelector('[role="status"]')?.textContent).toBe("Stopping");
    activity = [];
    await tick();
    expect(active.querySelector('[role="status"]')).toBeNull();
    expect(active.querySelector(".project-card-time")).not.toBeNull();
  });

  it.each(pages)("skips activity requests when $name has no projects", async ({ view }) => {
    await act(async () => root.render(view));
    await tick();
    expect(container.querySelector(".project-card-open")).toBeNull();
    expect(listActivity).not.toHaveBeenCalled();
  });
});

describe("project activity refresh", () => {
  it("avoids overlapping requests and aborts polling on unmount", async () => {
    let finish!: (value: ProjectAgentActivity[]) => void;
    listActivity.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => root.render(<Activity />));
    const signal = listActivity.mock.calls[0]![0]!;
    await tick();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listActivity).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    expect(signal.aborted).toBe(true);
    const previous = snapshot;
    await act(async () => finish([{ projectId: "late", status: "running" }]));
    await tick();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listActivity).toHaveBeenCalledTimes(1);
    expect(snapshot).toBe(previous);
  });

  it("pauses requests while hidden and refreshes immediately on return or focus", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => root.render(<Activity />));
    await tick();
    expect(listActivity).not.toHaveBeenCalled();
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(snapshot.get("active")).toBe("running");
    activity = [];
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(snapshot.size).toBe(0);
    expect(listActivity).toHaveBeenCalledTimes(2);
  });

  it("keeps the last status on a temporary failure and clears it after recovery", async () => {
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => root.render(<Activity />));
    listActivity.mockRejectedValueOnce(new Error("Runtime disconnected"));
    await tick();
    expect(snapshot.get("active")).toBe("running");
    activity = [];
    await tick();
    expect(snapshot.size).toBe(0);
  });

  it("waits for project loading and refreshes after a runtime restart", async () => {
    await act(async () => root.render(<Activity enabled={false} />));
    await tick();
    expect(listActivity).not.toHaveBeenCalled();
    activity = [{ projectId: "active", status: "running" }];
    await act(async () => root.render(<Activity />));
    const signal = listActivity.mock.calls[0]![0]!;
    activity = [];
    await act(async () => updateRuntimeConnection({ status: "ready", generation: runtimeConnection().generation + 1, recovered: true }));
    expect(signal.aborted).toBe(true);
    expect(listActivity).toHaveBeenCalledTimes(2);
    expect(snapshot.size).toBe(0);
  });

  it("retains the same snapshot when status responses only change order", async () => {
    activity = [{ projectId: "one", status: "running" }, { projectId: "two", status: "cancelling" }];
    await act(async () => root.render(<Activity />));
    const previous = snapshot;
    activity = [...activity].reverse();
    await tick();
    expect(snapshot).toBe(previous);
  });
});

function project(id: string, type: ProjectState["type"]): ProjectState {
  return { id, name: id, type, updatedAt: "2026-10-12T00:00:00Z", workspacePath: `/projects/${id}`, preview: { status: "waiting" } };
}
