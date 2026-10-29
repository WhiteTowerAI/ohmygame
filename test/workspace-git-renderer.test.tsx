// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/renderer/api.js";
import { WorkspaceFileBrowser } from "../src/renderer/coding-workspace.js";
import type {
  WorkspaceGitChanges,
  WorkspaceGitFileView,
} from "../src/shared/workspace-git.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const changes: WorkspaceGitChanges = {
  available: true,
  head: "head",
  changes: [
    { path: "game.ts", kind: "modified", lines: { added: 1, removed: 1 } },
    { path: "removed.ts", kind: "removed", lines: { added: 0, removed: 2 } },
  ],
};
const file: WorkspaceGitFileView = {
  path: "game.ts",
  before: { binary: false, content: "before\n" },
  after: { binary: false, content: "after\n" },
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "getWorkspaceGitChanges").mockResolvedValue(changes);
  vi.spyOn(api, "getWorkspaceGitFile").mockResolvedValue(file);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(
  projectId = "project",
  revision = 0,
  filesRevision = 0,
  openFileRequestId?: number,
  selectedPath = "saved.ts",
) {
  await act(async () =>
    root.render(
      <WorkspaceFileBrowser
        projectId={projectId}
        files={[]}
        selectedPath={selectedPath}
        selectedFile={{
          path: "saved.ts",
          size: 1,
          binary: false,
          content: "saved",
        }}
        loading={false}
        onSelect={() => {}}
        revision={revision}
        filesRevision={filesRevision}
        openFileRequestId={openFileRequestId}
      />,
    ),
  );
}
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) =>
      item.textContent === name || item.getAttribute("aria-label") === name,
  )!;
const click = (name: string) => act(async () => button(name).click());

describe("Code Git changes view", () => {
  it("puts the open file's path and a tree toggle in the panel toolbar, and keeps the tree while hidden", async () => {
    // Elements have a size unless something around them is hidden, and resizes are reported on request.
    const observers: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
    const measure = function (this: HTMLElement) { return this.closest("[hidden]") ? 0 : 320; };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(measure);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(measure);
    const resized = () => act(async () => observers.forEach((callback) => callback()));
    const toolbar = document.createElement("div");
    document.body.appendChild(toolbar);
    const props = {
      projectId: "project", files: [{ path: "src/saved.ts", size: 1 }], selectedPath: "src/saved.ts", loading: false, onSelect: () => {}, toolbarTarget: toolbar,
      selectedFile: { path: "src/saved.ts", size: 1, binary: false, content: "saved" },
    };
    await act(async () => root.render(<WorkspaceFileBrowser {...props} />));
    await resized();
    const tree = container.querySelector('[role="tree"]');
    expect(tree).not.toBeNull();
    expect(container.querySelector(".file-content-header")).toBeNull();
    expect(toolbar.querySelector(".file-content-path")?.textContent).toBe("src/saved.ts");
    expect(toolbar.querySelector(".file-content-name")?.textContent).toBe("saved.ts");
    const toggle = toolbar.querySelector<HTMLButtonElement>('button[aria-label="Hide files"]')!;
    await act(async () => toggle.click());
    expect(container.querySelector<HTMLElement>(".file-explorer")?.hidden).toBe(true);
    expect(container.querySelector(".code-view")?.classList.contains("is-tree-hidden")).toBe(true);
    // Hidden, the tree measures 0 but stays mounted, so its open folders and scroll stay.
    await resized();
    expect(container.querySelector('[role="tree"]')).toBe(tree);
    await act(async () => toolbar.querySelector<HTMLButtonElement>('button[aria-label="Show files"]')!.click());
    expect(container.querySelector<HTMLElement>(".file-explorer")?.hidden).toBe(false);
    expect(container.querySelector('[role="tree"]')).toBe(tree);
    toolbar.remove();
  });

  it("opens diffs only in Changes and preserves the selected file when returning to Files", async () => {
    await render();
    expect(api.getWorkspaceGitFile).not.toHaveBeenCalled();
    expect(container.querySelector(".file-content-path")?.textContent).toBe(
      "saved.ts",
    );
    await click("Changes2");
    expect(api.getWorkspaceGitFile).toHaveBeenCalledWith("project", "game.ts");
    expect(container.querySelector(".turn-change-diff")?.textContent).toContain(
      "before",
    );
    expect(container.querySelector(".turn-change-diff")?.textContent).toContain(
      "after",
    );
    await click("Dremoved.ts+0-2");
    expect(api.getWorkspaceGitFile).toHaveBeenLastCalledWith(
      "project",
      "removed.ts",
    );
    await click("Files");
    expect(container.querySelector(".file-content-path")?.textContent).toBe(
      "saved.ts",
    );
  });

  it("refreshes after workspace and file revisions, keeps selection, and clears a clean workspace", async () => {
    await render();
    await click("Changes2");
    await click("Dremoved.ts+0-2");
    await render("project", 1);
    expect(api.getWorkspaceGitFile).toHaveBeenLastCalledWith(
      "project",
      "removed.ts",
    );
    expect(button("Changes2").getAttribute("aria-pressed")).toBe("true");
    const count = vi.mocked(api.getWorkspaceGitChanges).mock.calls.length;
    await render("project", 1, 1, undefined, "renamed.ts");
    expect(api.getWorkspaceGitChanges).toHaveBeenCalledTimes(count + 1);
    expect(button("Changes2").getAttribute("aria-pressed")).toBe("true");
    vi.mocked(api.getWorkspaceGitChanges).mockResolvedValue({
      available: true,
      head: "new",
      changes: [],
    });
    await click("Refresh Git changes");
    expect(button("Changes0").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".git-diff-content")).toBeNull();
    expect(container.querySelector(".git-changes-list")?.textContent).toContain(
      "No uncommitted changes",
    );
  });

  it("keeps the file browser usable without Git and retries an initial Git error", async () => {
    vi.mocked(api.getWorkspaceGitChanges).mockRejectedValueOnce(
      new Error("Git unavailable"),
    );
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not read Git changes",
    );
    expect(container.querySelector(".file-content-path")?.textContent).toBe(
      "saved.ts",
    );
    vi.mocked(api.getWorkspaceGitChanges).mockResolvedValue({
      available: false,
      changes: [],
    });
    await click("Refresh Git changes");
    expect(container.querySelector(".file-explorer-views")).toBeNull();
    expect(api.getWorkspaceGitFile).not.toHaveBeenCalled();
  });

  it("opens an explicit source-file request in Files even when the path is unchanged", async () => {
    await render();
    await click("Changes2");
    await render("project", 0, 0, 1);
    expect(button("Files").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".file-content-path")?.textContent).toBe(
      "saved.ts",
    );
  });

  it("bounds displayed diff lines while keeping full line counts", async () => {
    vi.mocked(api.getWorkspaceGitChanges).mockResolvedValue({
      available: true,
      head: "head",
      changes: [
        { path: "many.ts", kind: "added", lines: { added: 1000, removed: 0 } },
      ],
    });
    vi.mocked(api.getWorkspaceGitFile).mockResolvedValue({
      path: "many.ts",
      before: null,
      after: {
        binary: false,
        content: Array.from({ length: 1000 }, (_, index) => `${index}\n`).join(
          "",
        ),
      },
    });
    await render();
    await click("Changes1");
    expect(container.querySelectorAll(".turn-change-line")).toHaveLength(500);
    expect(
      container.querySelector(".file-content-header .change-counts")
        ?.textContent,
    ).toBe("+1000-0");
    expect(
      container.querySelector(".git-diff-content .turn-changes-note"),
    ).not.toBeNull();
  });

  it("ignores a late diff response after selecting another file", async () => {
    let resolve!: (file: WorkspaceGitFileView) => void;
    vi.mocked(api.getWorkspaceGitFile).mockImplementation(
      async (_project, path) =>
        path === "game.ts"
          ? new Promise((done) => {
              resolve = done;
            })
          : {
              path,
              before: { binary: false, content: "deleted\n" },
              after: null,
            },
    );
    await render();
    await click("Changes2");
    await click("Dremoved.ts+0-2");
    await act(async () => resolve(file));
    expect(container.querySelector(".file-content-path")?.textContent).toBe(
      "removed.ts",
    );
    expect(container.querySelector(".turn-change-diff")?.textContent).toContain(
      "deleted",
    );
    expect(
      container.querySelector(".turn-change-diff")?.textContent,
    ).not.toContain("after");
  });
});
