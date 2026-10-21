// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const exportProject = vi.fn<(projectId: string) => Promise<Blob>>();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  exportProject,
  getProjectCover: async () => undefined,
}));
const { ProjectCard } = await import("../src/renderer/project-card.js");

const project: ProjectState = {
  id: "project-1",
  name: "Moon Garden",
  type: "web-game",
  updatedAt: "2026-10-20T12:00:00.000Z",
  workspacePath: "/projects/project-1/workspace",
  preview: { status: "waiting" },
};
const actions = {
  onRename: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
};

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let downloads: string[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  exportProject.mockReset();
  downloads = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:archive");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openMenu(): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectCard project={project} onOpen={() => {}} actions={actions} />,
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".project-card-menu")!.click();
  });
}

function menuItem(label: string): HTMLButtonElement {
  return [
    ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === label)!;
}

describe("project card export", () => {
  it("downloads the project archive under the project's name", async () => {
    exportProject.mockResolvedValue(new Blob(["zip"]));
    await openMenu();
    await act(async () => menuItem("Export project").click());
    expect(exportProject).toHaveBeenCalledWith("project-1");
    expect(downloads).toEqual(["Moon Garden.zip"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("shows why an export failed", async () => {
    exportProject.mockRejectedValue(
      new Error("Wait for the agent to finish before exporting"),
    );
    await openMenu();
    await act(async () => menuItem("Export project").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Wait for the agent to finish before exporting",
    );
    expect(downloads).toEqual([]);
  });
});
