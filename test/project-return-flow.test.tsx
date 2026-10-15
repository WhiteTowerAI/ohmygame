// @vitest-environment happy-dom
import path from "node:path";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const project: ProjectState = {
  id: "garden",
  name: "Garden",
  type: "general",
  workspacePath: "/tmp/garden",
  updatedAt: "2026-10-14T00:00:00Z",
  preview: { status: "stopped" },
};

vi.doMock(path.resolve("src/renderer/asset-canvas-quick-start.ts"), () => ({
  invalidateQuickStartModels: vi.fn(),
  loadQuickStartModels: vi.fn(),
}));
vi.doMock(
  path.resolve("src/renderer/runtime-connection.ts"),
  async (original) => ({
    ...(await original<
      typeof import("../src/renderer/runtime-connection.js")
    >()),
    useReadyRuntimeGeneration: () => 1,
  }),
);
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects: async () => [project],
  waitForRuntime: async () => undefined,
}));
vi.doMock(path.resolve("src/renderer/use-project-activity.ts"), () => ({
  useProjectActivity: () => new Map(),
}));
vi.doMock(path.resolve("src/renderer/sidebar-page.tsx"), () => ({
  SidebarPageLayout: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
  SidebarPageHeader: ({ actions }: { actions: React.ReactNode }) => (
    <header>{actions}</header>
  ),
}));
vi.doMock(path.resolve("src/renderer/project-card.tsx"), () => ({
  ProjectCard: ({ onOpen }: { onOpen: () => void }) => (
    <button onClick={onOpen}>Open Garden</button>
  ),
}));
vi.doMock(path.resolve("src/renderer/game-studio-home.tsx"), () => ({
  GameStudioHome: ({
    onOpenProject,
    onCreate,
  }: ComponentProps<
    typeof import("../src/renderer/game-studio-home.js").GameStudioHome
  >) => (
    <>
      <button onClick={() => onOpenProject(project.id)}>
        Open recent project
      </button>
      <button
        onClick={() =>
          onCreate(project, "first", "Make a garden", [], [], "normal")
        }
      >
        Create project
      </button>
    </>
  ),
}));
vi.doMock(path.resolve("src/renderer/project-shell.tsx"), () => ({
  ProjectShell: ({
    onHome,
    homeLabel,
    onOpenConversation,
    onViewChange,
  }: ComponentProps<
    typeof import("../src/renderer/project-shell.js").ProjectShell
  >) => (
    <>
      <button onClick={onHome}>{homeLabel}</button>
      <button onClick={() => onOpenConversation("second")}>
        Another conversation
      </button>
      <button onClick={() => onViewChange?.("design")}>Design</button>
    </>
  ),
}));

const { App } = await import("../src/renderer/app.js");
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "#/general");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}

describe("project return flow", () => {
  it.each(["Open recent project", "Create project"])(
    "returns to the studio after %s and project navigation",
    async (entry) => {
      await act(async () => root.render(<App />));
      await click(entry);
      await click("Another conversation");
      await click("Design");
      expect(window.location.hash).toBe(
        "#/projects/garden/conversations/second/design",
      );
      await click("Back to General Game");
      expect(window.location.hash).toBe("#/general");
    },
  );

  it("restores the actual list controls after editing filters, entering a project, and refreshing", async () => {
    window.history.replaceState(null, "", "#/projects?type=general");
    await act(async () => root.render(<App />));
    const input = container.querySelector<HTMLInputElement>(
      "#projects-search-input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Garden");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Sort projects"]')!
        .click(),
    );
    await click("Name");
    const entry = window.location.hash;
    expect(entry).toBe("#/projects?type=general&q=Garden&sort=name");
    await click("Open Garden");
    await click("Another conversation");
    await click("Design");
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    await click("Back to Projects");
    expect(window.location.hash).toBe(entry);
    expect(
      container.querySelector<HTMLInputElement>("#projects-search-input")!
        .value,
    ).toBe("Garden");
    expect(
      container.querySelector<HTMLSelectElement>('[aria-label="Project type"]')!
        .value,
    ).toBe("general");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Sort projects"]')!
        .click(),
    );
    expect(
      container.querySelector('[role="menuitem"].is-active')!.textContent,
    ).toBe("Name");
  });
});
