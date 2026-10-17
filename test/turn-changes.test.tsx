// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CheckpointChangeItem,
  CheckpointFileView,
  TurnChanges,
} from "../src/shared/contracts.js";
import {
  TurnChangesFooter,
  TurnChangesViews,
  type TurnChangesControls,
  type TurnUndoOutcome,
} from "../src/renderer/turn-changes.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const LIST: CheckpointChangeItem[] = [
  { path: "src/game.js", kind: "modified", state: "changed" },
  { path: "assets/hero.png", kind: "added", state: "applied" },
  { path: "old/notes.md", kind: "removed", state: "undone" },
];
const TEXT_FILE: CheckpointFileView = {
  path: "src/game.js",
  before: { binary: false, content: "one\ntwo\nthree\n" },
  after: { binary: false, content: "one\n2\nthree\n" },
};

function controls(overrides: Partial<TurnChangesControls> = {}) {
  return {
    disabled: false,
    load: vi.fn<TurnChangesControls["load"]>(async () => LIST),
    file: vi.fn<TurnChangesControls["file"]>(async () => TEXT_FILE),
    undo: vi.fn<TurnChangesControls["undo"]>(async () => ({
      status: "done",
      changed: ["src/game.js", "assets/hero.png", "old/notes.md"],
      conflicts: [],
    })),
    reapply: vi.fn<TurnChangesControls["reapply"]>(async () => ({
      status: "done",
      changed: ["src/game.js", "assets/hero.png", "old/notes.md"],
      conflicts: [],
      undone: false,
      kept: 0,
    })),
    ...overrides,
  };
}

/**
 * `turn` stands for the id of the turn around the footer, which a reloaded
 * conversation changes, and `revision` for the workspace's, which changes with its files.
 */
async function render(
  value: TurnChangesControls,
  changes: TurnChanges = { files: 3 },
  turn = "live-turn",
  revision = 0,
) {
  await act(async () =>
    root.render(
      <TurnChangesViews workspaceRevision={revision}>
        <article key={turn}>
          <TurnChangesFooter
            checkpointId="checkpoint-1"
            changes={changes}
            controls={value}
          />
        </article>
      </TurnChangesViews>,
    ),
  );
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (candidate) =>
      (candidate.getAttribute("aria-label") ?? candidate.textContent) === name,
  );
const buttons = () =>
  [...container.querySelectorAll("button:not(.turn-change-row)")].map(
    (candidate) => candidate.textContent,
  );
const click = (name: string) => act(async () => button(name)!.click());
const texts = (selector: string) =>
  [...container.querySelectorAll(selector)].map(
    (element) => element.textContent,
  );

describe("TurnChangesFooter", () => {
  it("starts folded with saved counts and reveals files and Undo only when opened", async () => {
    const items: CheckpointChangeItem[] = Array.from(
      { length: 6 },
      (_, index) => ({
        path: `src/file-${index}.ts`,
        kind: "modified",
        lines: { added: index + 1, removed: 1 },
      }),
    );
    const value = controls({ load: vi.fn(async () => items) });
    await render(value, { files: 6, items });
    expect(container.querySelector(".turn-changes-list")).toBeNull();
    expect(button("Undo")).toBeUndefined();
    expect(button("6 files changed")!.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(button("6 files changed")!.querySelector("svg")).not.toBeNull();
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+21-6"]);
    expect(value.load).not.toHaveBeenCalled();
    expect(value.file).not.toHaveBeenCalled();
    expect(button("View changes")).toBeUndefined();
    await click("6 files changed");
    expect(texts(".turn-change-path")).toHaveLength(6);
    expect(value.load).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector(".turn-changes-summary .turn-changes-undo"),
    ).toBeNull();
    expect(container.querySelector(".turn-changes-controls")!.textContent).toBe(
      "Undo",
    );
    await act(async () =>
      container
        .querySelector<HTMLElement>(".turn-change-row .change-count-added")!
        .click(),
    );
    expect(value.file).toHaveBeenCalledWith("checkpoint-1", items[0].path);
    expect(container.querySelector(".turn-change-diff")).not.toBeNull();
    await act(async () =>
      container
        .querySelector(".turn-change-row .turn-change-chevron")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(texts(".turn-change-path")).toHaveLength(6);
    expect(container.querySelector(".turn-change-diff")).toBeNull();
    await click("6 files changed");
    expect(container.querySelector(".turn-changes-list")).toBeNull();
    expect(button("Undo")).toBeUndefined();
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+21-6"]);
  });

  it("shows saved counts after leaving and reopening the conversation, folded and without requests", async () => {
    const items: CheckpointChangeItem[] = [
      { path: "notes.txt", kind: "added", lines: { added: 12, removed: 0 } },
      { path: "hero.png", kind: "added" },
    ];
    const value = controls();
    await render(value, { files: 2, items });
    await click("2 files changed");
    await act(async () => root.render(null));
    await render(value, { files: 2, items, undone: true }, "stored-turn");

    expect(button("2 files changed")!.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+12-0"]);
    expect(container.querySelector(".turn-changes-list")).toBeNull();
    expect(button("Reapply")).toBeUndefined();
    expect(value.load).toHaveBeenCalledTimes(1);
    expect(value.file).not.toHaveBeenCalled();
    await click("2 files changed");
    expect(button("Reapply")).toBeDefined();
  });

  it("restores legacy counts while folded and keeps them during a workspace refresh", async () => {
    const items: CheckpointChangeItem[] = [
      { path: "notes.txt", kind: "modified", lines: { added: 2, removed: 1 } },
    ];
    let finish!: (items: CheckpointChangeItem[]) => void;
    const value = controls({
      load: vi
        .fn<TurnChangesControls["load"]>()
        .mockResolvedValueOnce(items)
        .mockResolvedValueOnce(items)
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
    });
    await render(value, { files: 1 });
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+2-1"]);
    expect(container.querySelector(".turn-changes-list")).toBeNull();
    await act(async () => root.render(null));
    await render(value, { files: 1 }, "stored-turn");
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+2-1"]);
    expect(button("1 file changed")!.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(value.load).toHaveBeenCalledTimes(2);
    await render(value, { files: 1, undone: true }, "stored-turn", 1);
    expect(value.load).toHaveBeenCalledTimes(2);
    await click("1 file changed");
    expect(value.load).toHaveBeenCalledTimes(3);
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+2-1"]);
    expect(texts(".turn-change-row .change-counts")).toEqual(["+2-1"]);
    expect(button("Reapply")).toBeDefined();
    await act(async () =>
      finish(items.map((item) => ({ ...item, state: "undone" }))),
    );
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+2-1"]);
    expect(value.file).not.toHaveBeenCalled();
  });

  it("caps a large file diff without reducing the saved counts", async () => {
    const lines = 5_000;
    const value = controls({
      load: vi.fn(async () => [{ path: "large.txt", kind: "added" as const }]),
      file: vi.fn(async () => ({
        path: "large.txt",
        before: null,
        after: { binary: false, content: "line\n".repeat(lines) },
      })),
    });
    await render(value, {
      files: 1,
      items: [
        {
          path: "large.txt",
          kind: "added",
          lines: { added: lines, removed: 0 },
        },
      ],
    });
    await click("1 file changed");
    await click("large.txt");
    expect(container.querySelectorAll(".turn-change-line")).toHaveLength(2_000);
    expect(texts(".turn-changes-note")).toContain(
      "Only part of this diff is shown.",
    );
    expect(texts(".turn-changes-summary .change-counts")).toEqual(["+5000-0"]);
  });

  it("keeps saved statistics and an open diff after an undo refreshes the workspace", async () => {
    const items = [
      {
        path: "notes.txt",
        kind: "modified" as const,
        lines: { added: 2, removed: 1 },
      },
    ];
    const value = controls({ load: vi.fn(async () => items) });
    await render(value, { files: 1, items });
    await click("1 file changed");
    await click("notes.txt");
    expect(texts(".turn-change-row .change-counts")).toEqual(["+2-1"]);
    await render(value, { files: 1, items, undone: true }, "reloaded-turn", 1);
    expect(texts(".turn-change-row .change-counts")).toEqual(["+2-1"]);
    expect(button("Undo")).toBeUndefined();
    expect(button("Reapply")).toBeDefined();
    expect(container.querySelector(".turn-change-diff")).not.toBeNull();
    expect(value.file).toHaveBeenCalledTimes(1);
    expect(value.load).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted Reapply state when a conversation reload replaces a local Undo result", async () => {
    const value = controls();
    await render(value);
    await click("3 files changed");
    await click("Undo");
    await render(value, { files: 3, undone: true }, "stored-turn");
    expect(button("Reapply")).toBeDefined();
    await render(value, { files: 3 }, "reapplied-turn");
    expect(button("Reapply")).toBeUndefined();
    expect(button("Undo")).toBeDefined();
  });

  it("keeps Reapply available for pre-undo edits even if files equal the original turn end", async () => {
    const value = controls({
      load: vi.fn(async () =>
        LIST.map((item) => ({ ...item, state: "applied" as const })),
      ),
    });
    await render(value, { files: 3, undone: true });
    await click("3 files changed");
    expect(button("Undo")).toBeDefined();
    expect(button("Reapply")).toBeDefined();
    await click("Reapply");
    expect(value.reapply).toHaveBeenCalledTimes(1);
  });

  it("loads missing summaries while folded and reveals the cached file list on demand", async () => {
    const value = controls();
    await render(value);

    expect(value.load).toHaveBeenCalledTimes(1);
    expect(button("3 files changed")!.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(container.querySelector(".turn-changes-list")).toBeNull();

    await click("3 files changed");

    expect(value.load).toHaveBeenCalledTimes(1);
    expect(value.load).toHaveBeenCalledWith("checkpoint-1");
    expect(button("3 files changed")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(texts(".turn-change-row")).toEqual([
      "src/game.js—Changed later",
      "assets/hero.png—",
      "old/notes.md—Already put back",
    ]);
    expect(texts(".turn-change-badge")).toEqual([
      "Changed later",
      "Already put back",
    ]);

    await click("3 files changed");
    expect(container.querySelector(".turn-changes-list")).toBeNull();
    await click("3 files changed");
    expect(texts(".turn-change-path")).toEqual([
      "src/game.js",
      "assets/hero.png",
      "old/notes.md",
    ]);
    expect(value.load).toHaveBeenCalledTimes(1);
  });

  it("shows a list that could not be loaded as an error and asks again when it is reopened", async () => {
    const value = controls({
      load: vi
        .fn<TurnChangesControls["load"]>()
        .mockRejectedValueOnce(new Error("Checkpoint not found"))
        .mockRejectedValueOnce(new Error("Checkpoint not found"))
        .mockResolvedValue(LIST),
    });
    await render(value, { files: 1 });
    expect(value.load).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await click("1 file changed");
    expect(texts('[role="alert"]')).toEqual(["Checkpoint not found"]);

    await click("1 file changed");
    await click("1 file changed");
    expect(value.load).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(texts(".turn-change-path")).toHaveLength(3);
  });

  it("shows the removed and the added lines of a file once it is opened", async () => {
    const value = controls();
    await render(value);
    await click("3 files changed");
    expect(value.file).not.toHaveBeenCalled();

    await click("src/game.js");

    expect(value.file).toHaveBeenCalledTimes(1);
    expect(value.file).toHaveBeenCalledWith("checkpoint-1", "src/game.js");
    expect(button("src/game.js")!.getAttribute("aria-expanded")).toBe("true");
    expect(texts(".turn-change-line")).toEqual([
      "11 one",
      "2-two",
      "2+2",
      "33 three",
    ]);
    expect(texts(".turn-change-line-removed")).toEqual(["2-two"]);
    expect(texts(".turn-change-line-added")).toEqual(["2+2"]);

    await click("src/game.js");
    expect(container.querySelector(".turn-change-diff")).toBeNull();
    await click("src/game.js");
    expect(container.querySelector(".turn-change-diff")).not.toBeNull();
    expect(value.file).toHaveBeenCalledTimes(1);
  });

  it("separates distant changes and shows a file that was added or removed whole", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const views: Record<string, CheckpointFileView> = {
      "src/game.js": {
        path: "src/game.js",
        before: { binary: false, content: lines.join("\n") },
        after: {
          binary: false,
          content: lines
            .map((line, index) =>
              index === 1 || index === 18 ? `${line}!` : line,
            )
            .join("\n"),
        },
      },
      "assets/hero.png": {
        path: "assets/hero.png",
        before: null,
        after: { binary: false, content: "new\nfile\n", truncated: true },
      },
      "old/notes.md": {
        path: "old/notes.md",
        before: { binary: false, content: "gone\n" },
        after: null,
      },
    };
    const value = controls({
      file: vi.fn<TurnChangesControls["file"]>(
        async (_checkpointId, path) => views[path],
      ),
    });
    await render(value);
    await click("3 files changed");

    await click("src/game.js");
    expect(container.querySelectorAll(".turn-change-gap")).toHaveLength(1);
    expect(texts(".turn-change-line-removed")).toEqual([
      "2-line 2",
      "19-line 19",
    ]);

    await click("src/game.js");
    await click("assets/hero.png");
    expect(texts(".turn-change-line")).toEqual(["1+new", "2+file"]);
    expect(container.textContent).toContain(
      "Only the beginning of this file is shown.",
    );

    await click("assets/hero.png");
    await click("old/notes.md");
    expect(texts(".turn-change-line")).toEqual(["1-gone"]);
    expect(container.textContent).not.toContain(
      "Only the beginning of this file is shown.",
    );
  });

  it("shows no content for a binary file and an error for a file that cannot be read", async () => {
    const file = vi
      .fn<TurnChangesControls["file"]>()
      .mockResolvedValueOnce({
        path: "assets/hero.png",
        before: null,
        after: { binary: true },
      })
      .mockRejectedValueOnce(new Error("File not found"));
    const value = controls({ file });
    await render(value);
    await click("3 files changed");

    await click("assets/hero.png");
    expect(container.textContent).toContain("Binary file");
    expect(container.querySelector(".turn-change-diff")).toBeNull();

    await click("old/notes.md");
    expect(texts('[role="alert"]')).toEqual(["File not found"]);

    // A file that could not be read is asked for again when it is reopened.
    file.mockResolvedValueOnce({
      path: "old/notes.md",
      before: { binary: false, content: "gone\n" },
      after: null,
    });
    await click("old/notes.md");
    await click("old/notes.md");
    expect(file).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(texts(".turn-change-line")).toEqual(["1-gone"]);
  });

  it("does not call the lines the same when only the beginning of a longer file was compared", async () => {
    const part = { binary: false, content: "one\ntwo\n", truncated: true };
    const file = vi
      .fn<TurnChangesControls["file"]>()
      .mockResolvedValueOnce({ path: "src/game.js", before: part, after: part })
      .mockResolvedValueOnce({
        path: "assets/hero.png",
        before: { binary: false, content: "one\n" },
        after: { binary: false, content: "one\r\n" },
      });
    const value = controls({ file });
    await render(value);
    await click("3 files changed");

    await click("src/game.js");
    expect(texts(".turn-change .turn-changes-note")).toEqual([
      "The part shown does not differ. The file is longer than what is shown.",
    ]);

    await click("src/game.js");
    await click("assets/hero.png");
    expect(texts(".turn-change .turn-changes-note")).toEqual([
      "The lines are the same. Only line endings or file permissions changed.",
    ]);
  });

  it("undoes directly after expanding, without confirmation, and allows Reapply then Undo", async () => {
    const value = controls();
    await render(value, { files: 31 });
    await click("31 files changed");
    await click("Undo");
    expect(value.undo).toHaveBeenCalledWith(
      "checkpoint-1",
      undefined,
      undefined,
    );
    expect(container.querySelector(".turn-changes-panel")).toBeNull();
    expect(button("Undo")).toBeUndefined();
    expect(button("Reapply")).toBeDefined();
    await click("Reapply");
    expect(value.reapply).toHaveBeenCalledWith(
      "checkpoint-1",
      undefined,
      undefined,
    );
    expect(texts('[role="status"]')).toEqual(["3 files reapplied."]);
    expect(button("Reapply")).toBeUndefined();
    await click("Undo");
    expect(value.undo).toHaveBeenCalledTimes(2);
  });

  it("does not offer Reapply when no files were undone", async () => {
    const value = controls({
      undo: vi.fn<TurnChangesControls["undo"]>(async () => ({
        status: "done",
        changed: [],
        conflicts: [],
        undone: false,
        kept: 0,
      })),
    });
    await render(value);
    await click("3 files changed");
    await click("Undo");
    expect(texts('[role="status"]')).toEqual(["No files were put back."]);
    expect(button("Undo")).toBeDefined();
    expect(button("Reapply")).toBeUndefined();
  });

  it("can cancel a conflict without making a second write request", async () => {
    const value = controls({
      undo: vi.fn<TurnChangesControls["undo"]>(async () => ({
        status: "conflicts",
        conflicts: ["src/game.js"],
        blocked: false,
      })),
    });
    await render(value);
    await click("3 files changed");
    await click("Undo");
    await click("Cancel");
    expect(value.undo).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".turn-changes-panel")).toBeNull();
  });

  it("asks about Reapply conflicts and retries only the displayed paths", async () => {
    const reapply = vi
      .fn<TurnChangesControls["reapply"]>()
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["src/game.js"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["src/game.js", "assets/hero.png"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "done",
        changed: ["old/notes.md"],
        conflicts: ["src/game.js", "assets/hero.png"],
        undone: true,
        kept: 1,
      });
    const value = controls({ reapply });
    await render(value, { files: 3, undone: true });
    await click("3 files changed");
    await click("Reapply");
    expect(texts(".turn-changes-panel p")[0]).toBe(
      "These files were edited after Undo:",
    );
    await click("Overwrite them");
    expect(reapply).toHaveBeenLastCalledWith("checkpoint-1", "overwrite", [
      "src/game.js",
    ]);
    expect(texts(".turn-changes-conflicts li")).toEqual([
      "src/game.js",
      "assets/hero.png",
    ]);
    expect(container.textContent).toContain("in the meantime");
    await click("Keep them");
    expect(reapply).toHaveBeenLastCalledWith("checkpoint-1", "keep", undefined);
    expect(texts('[role="status"]')).toEqual([
      "1 file reapplied. 2 files were left as they are.",
    ]);
    expect(button("Reapply")).toBeDefined();
  });

  it("asks what to do with files that were changed later and keeps them on request", async () => {
    const undo = vi
      .fn<TurnChangesControls["undo"]>()
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["src/game.js", "old/notes.md"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "done",
        changed: ["assets/hero.png"],
        conflicts: ["old/notes.md", "src/game.js"],
      });
    const value = controls({ undo });
    await render(value);

    await click("3 files changed");
    await click("Undo");

    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain("These files were changed again after this turn:");
    expect(texts(".turn-changes-conflicts li")).toEqual([
      "src/game.js",
      "old/notes.md",
    ]);
    expect(buttons()).toEqual([
      "3 files changed",
      "Undo",
      "Keep them",
      "Overwrite them",
      "Cancel",
    ]);

    await click("Keep them");

    expect(undo).toHaveBeenLastCalledWith("checkpoint-1", "keep", undefined);
    expect(container.querySelector(".turn-changes-panel")).toBeNull();
    expect(texts('[role="status"]')).toEqual([
      "1 file was put back. 2 files were left as they are.",
    ]);
  });

  it("overwrites them on request, and offers only the rest when some cannot be put back", async () => {
    const undo = vi
      .fn<TurnChangesControls["undo"]>()
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["src/game.js", "old/notes.md"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["old/notes.md"],
        blocked: true,
      })
      .mockResolvedValueOnce({
        status: "done",
        changed: [],
        conflicts: ["old/notes.md", "src/game.js"],
      });
    const value = controls({ undo });
    await render(value);
    await click("3 files changed");
    await click("Undo");

    await click("Overwrite them");

    // The files that were shown go along: no other file may be overwritten.
    expect(undo).toHaveBeenLastCalledWith("checkpoint-1", "overwrite", [
      "src/game.js",
      "old/notes.md",
    ]);
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).toContain(
      "These files cannot be put back because other files are in their place:",
    );
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).not.toContain("in the meantime");
    expect(texts(".turn-changes-conflicts li")).toEqual(["old/notes.md"]);
    expect(buttons()).toEqual([
      "3 files changed",
      "Undo",
      "Undo the rest",
      "Cancel",
    ]);

    await click("Undo the rest");

    expect(undo).toHaveBeenCalledTimes(3);
    expect(undo).toHaveBeenLastCalledWith("checkpoint-1", "keep", undefined);
    expect(texts('[role="status"]')).toEqual([
      "No files were put back. 2 files were left as they are.",
    ]);
  });

  it("shows the new list when more files were changed before the answer to overwrite", async () => {
    const undo = vi
      .fn<TurnChangesControls["undo"]>()
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["src/game.js"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "conflicts",
        conflicts: ["assets/hero.png", "src/game.js"],
        blocked: false,
      })
      .mockResolvedValueOnce({
        status: "done",
        changed: ["assets/hero.png", "src/game.js"],
        conflicts: [],
      });
    const value = controls({ undo });
    await render(value);
    await click("3 files changed");
    await click("Undo");
    expect(
      container.querySelector(".turn-changes-panel")!.textContent,
    ).not.toContain("in the meantime");

    await click("Overwrite them");

    expect(undo).toHaveBeenLastCalledWith("checkpoint-1", "overwrite", [
      "src/game.js",
    ]);
    expect(texts(".turn-changes-panel p")).toEqual([
      "More files were changed in the meantime, so nothing was overwritten.",
      "These files were changed again after this turn:",
      "Keep them to put back only the other files, or overwrite them and lose what was changed later.",
    ]);
    expect(texts(".turn-changes-conflicts li")).toEqual([
      "assets/hero.png",
      "src/game.js",
    ]);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(buttons()).toEqual([
      "3 files changed",
      "Undo",
      "Keep them",
      "Overwrite them",
      "Cancel",
    ]);

    await click("Overwrite them");

    expect(undo).toHaveBeenLastCalledWith("checkpoint-1", "overwrite", [
      "assets/hero.png",
      "src/game.js",
    ]);
    expect(texts('[role="status"]')).toEqual(["2 files were put back."]);
  });

  it("shows a failure in the footer and lets the user try again", async () => {
    const undo = vi
      .fn<TurnChangesControls["undo"]>()
      .mockResolvedValueOnce({
        status: "failed",
        message: "Wait for the agent to finish before undoing",
      })
      .mockResolvedValueOnce({
        status: "done",
        changed: ["src/game.js"],
        conflicts: [],
      });
    const value = controls({ undo });
    await render(value);

    await click("3 files changed");
    await click("Undo");

    expect(texts('[role="alert"]')).toEqual([
      "Wait for the agent to finish before undoing",
    ]);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(button("Undo")!.disabled).toBe(false);

    await click("Undo");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(texts('[role="status"]')).toEqual(["1 file was put back."]);
  });

  it("disables its undo buttons while a request is under way and while undo is not available", async () => {
    let finish!: (outcome: TurnUndoOutcome) => void;
    const value = controls({
      undo: vi.fn<TurnChangesControls["undo"]>(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    });
    await render(value);
    await click("3 files changed");
    await click("Undo");

    expect(button("Undo")!.disabled).toBe(true);
    expect(value.undo).toHaveBeenCalledTimes(1);

    await act(async () =>
      finish({
        status: "conflicts",
        conflicts: ["src/game.js"],
        blocked: false,
      }),
    );
    expect(button("Keep them")!.disabled).toBe(false);

    await render({ ...value, disabled: true });
    expect(button("Undo")!.disabled).toBe(true);
    expect(button("Keep them")!.disabled).toBe(true);
    expect(button("Overwrite them")!.disabled).toBe(true);
    // Looking at the changes and backing out stay possible.
    expect(button("3 files changed")!.disabled).toBe(false);
    expect(button("Cancel")!.disabled).toBe(false);
  });

  it("keeps what it shows when the conversation is reloaded under other turn ids", async () => {
    const value = controls({
      load: vi
        .fn<TurnChangesControls["load"]>()
        .mockResolvedValueOnce(LIST)
        .mockResolvedValue(LIST.map((item) => ({ ...item, state: "undone" }))),
    });
    await render(value);
    await click("3 files changed");
    await click("src/game.js");
    await click("Undo");
    const footer = container.querySelector(".turn-changes");

    await render(value, { files: 3, undone: true }, "stored-turn");

    expect(container.querySelector(".turn-changes")).not.toBe(footer);
    expect(button("3 files changed")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(texts(".turn-change-path")).toHaveLength(3);
    expect(container.querySelector(".turn-change-diff")).not.toBeNull();
    expect(texts('[role="status"]')).toEqual(["3 files were put back."]);
    expect(button("Reapply")).toBeDefined();
    expect(button("Undo")).toBeUndefined();
    expect(value.load).toHaveBeenCalledTimes(2);
    expect(value.file).toHaveBeenCalledTimes(1);
  });

  it("offers to undo the rest of a turn that was undone in part", async () => {
    const value = controls({
      undo: vi.fn<TurnChangesControls["undo"]>(async () => ({
        status: "done",
        changed: ["src/game.js"],
        conflicts: [],
      })),
    });
    await render(value, { files: 3, undone: true, kept: 1 });
    await click("3 files changed");

    expect(container.querySelector(".turn-changes-undone")!.textContent).toBe(
      "Partly undone",
    );
    expect(button("Undo")).toBeUndefined();

    await click("Undo the rest");

    expect(value.undo).toHaveBeenCalledWith(
      "checkpoint-1",
      undefined,
      undefined,
    );
    expect(texts('[role="status"]')).toEqual(["1 file was put back."]);
  });

  it("offers undo again once the list shows a change of an undone turn in place", async () => {
    const undone = LIST.map((item): CheckpointChangeItem => ({
      ...item,
      state: "undone",
    }));
    const value = controls({
      load: vi
        .fn<TurnChangesControls["load"]>()
        .mockResolvedValueOnce(undone)
        .mockResolvedValue([
          { ...undone[0], state: "applied" },
          ...undone.slice(1),
        ]),
    });
    await render(value, { files: 3, undone: true });

    expect(button("Reapply")).toBeUndefined();
    await click("3 files changed");
    expect(button("Reapply")).toBeDefined();
    expect(button("Undo")).toBeUndefined();
    await render(value, { files: 3, undone: true }, "live-turn", 1);
    expect(button("Reapply")).toBeDefined();
    expect(button("Undo the rest")).toBeDefined();
    await click("Undo the rest");
    expect(value.undo).toHaveBeenCalledWith(
      "checkpoint-1",
      undefined,
      undefined,
    );
  });

  it("loads what it shows again when the workspace changed, and keeps the rest", async () => {
    const lists: Array<(list: CheckpointChangeItem[]) => void> = [];
    const value = controls({
      load: vi.fn<TurnChangesControls["load"]>(
        () =>
          new Promise((resolve) => {
            lists.push(resolve);
          }),
      ),
      undo: vi.fn<TurnChangesControls["undo"]>(async () => ({
        status: "done",
        changed: ["assets/hero.png"],
        conflicts: ["src/game.js"],
      })),
    });
    await render(value);
    await click("3 files changed");
    await act(async () => lists[0](LIST));
    await click("assets/hero.png");
    await click("Undo");
    expect(value.load).toHaveBeenCalledTimes(2);
    expect(value.file).toHaveBeenCalledTimes(1);

    // The files changed before the list that was asked for after the undo arrived.
    await render(value, { files: 3, undone: true, kept: 1 }, "live-turn", 1);

    expect(value.load).toHaveBeenCalledTimes(3);
    expect(button("3 files changed")!.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(texts('[role="status"]')).toEqual([
      "1 file was put back. 1 file was left as it is.",
    ]);
    // Immutable paths remain visible while their current state refreshes.
    expect(texts(".turn-change-path")).toHaveLength(3);
    expect(texts(".turn-change-badge")).toEqual([]);

    await act(async () =>
      lists[2](LIST.map((item) => ({ ...item, state: "undone" }))),
    );
    expect(texts(".turn-change-badge")).toEqual([
      "Already put back",
      "Already put back",
      "Already put back",
    ]);
    // Its immutable diff stays cached and open while the current path state refreshes.
    expect(value.file).toHaveBeenCalledTimes(1);
    expect(button("assets/hero.png")!.getAttribute("aria-expanded")).toBe(
      "true",
    );

    // The answer of the earlier load says how the files stood before, so it is dropped.
    await act(async () => lists[1](LIST));
    expect(texts(".turn-change-badge")).toEqual([
      "Already put back",
      "Already put back",
      "Already put back",
    ]);
  });
});
