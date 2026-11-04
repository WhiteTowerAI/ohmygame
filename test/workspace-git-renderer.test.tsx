// @vitest-environment happy-dom
import { act, memo } from "react";
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

describe("Code file browser refresh", () => {
  const files = () => [{ path: "src/deep/saved.ts", size: 1 }, { path: "other.ts", size: 1 }];
  const selectedFile = { path: "src/deep/saved.ts", size: 1, binary: false, content: "saved code" };
  const props = { projectId: "project", selectedPath: selectedFile.path, selectedFile, loading: false, onSelect: () => {} };

  /** Gives elements a size, so the tree mounts, and returns a call that reports it. */
  function sized() {
    const observers: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    return () => act(async () => observers.forEach((callback) => callback()));
  }
  const fileRow = () => container.querySelector('.file-tree-node[title="src/deep/saved.ts"]');
  const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  it("leaves a folder closed by hand when a refresh brings a new file list", async () => {
    const resized = sized();
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} />));
    await resized();
    await settled();
    expect(fileRow()).not.toBeNull();

    await click("Collapse src");
    expect(fileRow()).toBeNull();
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} />));
    await settled();
    expect(fileRow()).toBeNull();
  });

  it("brings the file back into view when it is asked for again", async () => {
    const resized = sized();
    const list = files();
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={list} openFileRequestId={1} />));
    await resized();
    await settled();
    await click("Collapse src");
    expect(fileRow()).toBeNull();

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={list} openFileRequestId={2} />));
    await settled();
    expect(fileRow()).not.toBeNull();
  });

  it("shows the open file on coming back from Changes, then leaves the new tree to refreshes", async () => {
    const resized = sized();
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} />));
    await resized();
    await settled();
    const view = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((item) => item.textContent?.startsWith(name))!;

    await act(async () => view("Changes").click());
    await settled();
    expect(container.querySelector(".file-tree")).toBeNull();
    await act(async () => view("Files").click());
    await settled();
    expect(fileRow()).not.toBeNull();

    await click("Collapse src");
    expect(fileRow()).toBeNull();
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} />));
    await settled();
    expect(fileRow()).toBeNull();
  });

  it("keeps the open file on screen while a refresh runs or after it fails", async () => {
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} loading />));
    expect(container.querySelector(".file-content")?.textContent).toContain("saved code");
    expect(container.textContent).not.toContain("Loading file");

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} error="Could not list files" />));
    expect(container.querySelector(".file-content")?.textContent).toContain("saved code");
    expect(container.textContent).not.toContain("Could not list files");
  });

  it("does not show the last file once the selection has moved on", async () => {
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} selectedPath="other.ts" error="Could not read file" />));
    expect(container.querySelector(".file-content")?.textContent).toContain("Could not read file");
    expect(container.textContent).not.toContain("saved code");

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} selectedPath="other.ts" loading />));
    expect(container.querySelector(".file-content")?.textContent).toContain("Loading file");
    expect(container.textContent).not.toContain("saved code");
  });

  it("shows the state of a file that is not loaded yet, and keeps the tree when a refresh fails with none open", async () => {
    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} selectedFile={undefined} loading />));
    expect(container.querySelector(".file-content")?.textContent).toContain("Loading file");

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} selectedFile={undefined} error="Could not read file" />));
    expect(container.querySelector(".file-content")?.textContent).toContain("Could not read file");

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={files()} selectedPath={undefined} selectedFile={undefined} error="Could not list files" />));
    expect(container.querySelector(".file-explorer")).not.toBeNull();
    expect(container.querySelector(".file-content")?.textContent).toContain("Could not list files");

    await act(async () => root.render(<WorkspaceFileBrowser {...props} files={[]} selectedPath={undefined} selectedFile={undefined} error="Could not list files" />));
    expect(container.querySelector(".file-explorer")).toBeNull();
    expect(container.textContent).toContain("Could not list files");
  });
});

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
    // The tree stays beside the code; there is no toggle to hide it.
    expect(toolbar.querySelector('button[aria-label="Hide files"]')).toBeNull();
    expect(container.querySelector<HTMLElement>(".file-explorer")?.hidden).toBe(false);
    toolbar.remove();
  });

  it("opens a second file tree while another is still mounted", async () => {
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { queueMicrotask(callback); } observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const props = { files: [{ path: "src/saved.ts", size: 1 }], selectedPath: "src/saved.ts", loading: false, onSelect: () => {} };
    const First = memo(() => <WorkspaceFileBrowser {...props} />);
    const errors: unknown[] = [];
    const tree = (second: boolean) => <><First />{second ? <WorkspaceFileBrowser {...props} /> : null}</>;
    await act(async () => root.render(tree(false)));
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(1);
    // react-dnd forgets its shared manager once no provider holds it, as when
    // the one tree was hidden and shown again, while that tree keeps using it.
    (globalThis as Record<symbol, unknown>)[Symbol.for("__REACT_DND_CONTEXT_INSTANCE__")] = null;
    try {
      await act(async () => root.render(tree(true)));
    } catch (cause) {
      errors.push(cause);
    }
    expect(errors).toEqual([]);
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(2);
    expect((window as unknown as { __isReactDndBackendSetUp?: boolean }).__isReactDndBackendSetUp).toBeFalsy();
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
