// @vitest-environment happy-dom
import path from "node:path";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import { createPlayableStarterCodebase } from "../src/daemon/playable-codebase.js";
import { desktopSave } from "../src/renderer/desktop-save.js";
import { takePlaytestRequest } from "../src/renderer/playable-playtest.js";

const codebase = createStarterCodebaseWithScene("Playtest", {
  width: 1280,
  height: 720,
});
/** What the editor loads from disk. */
let disk = codebase;
const update = vi.fn(async () => ({ revision: "saved" }));
/** How the daemon describes the story: one made before web stories is not `web` yet. */
let upgradeStatus = { web: false };
const upgradeStory = vi.fn(async () => ({ copiedAssets: [], missingAssets: [], rewritten: [], changed: [] }));
let move!: (
  event: unknown,
  viewport: { x: number; y: number; zoom: number },
) => void;
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: {
    onMoveEnd: typeof move;
    onNodeDoubleClick: (event: unknown, node: { id: string }) => void;
  }) => {
    move = props.onMoveEnd;
    return (
      <button onClick={() => props.onNodeDoubleClick(null, { id: "start" })}>
        Open Scene
      </button>
    );
  },
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeCodebase: async () => ({
    ...structuredClone(disk),
    revision: "disk",
  }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  getStoryUpgrade: async () => ({ ...upgradeStatus }),
  upgradeStory,
  updateNodeCodebase: update,
}));
vi.doMock(path.resolve("src/renderer/playable-node-workbench.tsx"), () => ({
  PlayableNodeWorkbench: () => <div aria-label="Scene workbench" />,
}));
const { PlayableEditorWorkspace } =
  await import("../src/renderer/playable-editor-workspace.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;

beforeEach(async () => {
  disk = codebase;
  upgradeStatus = { web: false };
  upgradeStory.mockReset().mockResolvedValue({ copiedAssets: [], missingAssets: [], rewritten: [], changed: [] });
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  update.mockReset().mockResolvedValue({ revision: "saved" });
  await renderEditor();
});

async function renderEditor(
  props: Partial<ComponentProps<typeof PlayableEditorWorkspace>> = {},
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await renderWorkspace(props);
  await act(async () => move(null, { x: 32, y: 64, zoom: 1.2 }));
}

async function renderWorkspace(
  props: Partial<ComponentProps<typeof PlayableEditorWorkspace>> = {},
): Promise<void> {
  await act(async () =>
    root.render(
      <PlayableEditorWorkspace
        project={{ id: "p", type: "interactive-story" } as ProjectState}
        agentBusy={false}
        publishing={false}
        onPublish={async () => false}
        onOpenPublish={() => {}}
        onClosePublish={() => {}}
        {...props}
      />,
    ),
  );
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  desktopSave.cancel();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function playtestWindow(href = "about:blank") {
  return { location: { href }, closed: false, focus: vi.fn(), close: vi.fn() };
}

it("opens the browser window during the click and waits for persistence before sending Replay", async () => {
  const playtest = playtestWindow();
  const open = vi
    .spyOn(window, "open")
    .mockReturnValue(playtest as unknown as Window);
  let finish!: (result: { revision: string }) => void;
  update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Playtest actions"]',
      )!
      .click(),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    expect(open).toHaveBeenCalledExactlyOnceWith("", "ohmygame-playtest");
  });
  expect(update).toHaveBeenCalledOnce();
  expect(playtest.location.href).toBe("about:blank");
  expect(takePlaytestRequest("p")).toBeUndefined();
  await act(async () => finish({ revision: "saved" }));
  expect(playtest.location.href).toContain("#/playtest/p");
  expect(playtest.focus).toHaveBeenCalledOnce();
  expect(takePlaytestRequest("p")).toEqual({ action: "replay" });
});

it.each(["about:blank", "http://localhost/#/playtest/p"])(
  "on save failure closes only a newly opened blank window (%s)",
  async (href) => {
    const playtest = playtestWindow(href);
    vi.spyOn(window, "open").mockReturnValue(playtest as unknown as Window);
    update.mockRejectedValueOnce(new Error("Disk unavailable"));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Playtest"]')!
        .click(),
    );
    expect(playtest.close).toHaveBeenCalledTimes(
      href === "about:blank" ? 1 : 0,
    );
    expect(playtest.location.href).toBe(href);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Disk unavailable",
    );
    expect(takePlaytestRequest("p")).toBeUndefined();
  },
);

it("reports a blocked popup before saving or sending an action", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Playtest"]')!
      .click(),
  );
  expect(update).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Allow pop-ups to open Playtest.",
  );
  expect(takePlaytestRequest("p")).toBeUndefined();
});

it("says to add a Scene instead of opening Playtest for a story with no Scenes", async () => {
  await act(async () => root.unmount());
  container.remove();
  disk = createPlayableStarterCodebase("Empty", { width: 1280, height: 720 });
  await renderEditor();
  update.mockClear();
  const open = vi.spyOn(window, "open");
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Playtest"]',
  )!;
  await act(async () => button.click());
  expect(open).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Add a Scene to playtest the story.",
  );
  expect(takePlaytestRequest("p")).toBeUndefined();
});

it("leaves Design and closes the Scene workbench when Playtest asks for the Story map", async () => {
  // Open the Scene through the canvas, as a double-click would.
  const openScene = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Open Scene",
  )!;
  await act(async () => openScene.click());
  expect(
    container.querySelector('[aria-label="Scene workbench"]'),
  ).not.toBeNull();
  const onDesignOpenChange = vi.fn();
  const onStoryMapShown = vi.fn();
  await renderWorkspace({
    designOpen: true,
    showStoryMap: true,
    onDesignOpenChange,
    onStoryMapShown,
  });
  expect(container.querySelector('[aria-label="Scene workbench"]')).toBeNull();
  expect(onDesignOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(onStoryMapShown).toHaveBeenCalledOnce();
});

it("applies a pending Story map request after loading the saved Code tab, then consumes it", async () => {
  await act(async () => root.unmount());
  container.remove();
  disk = {
    ...structuredClone(codebase),
    editorLayout: { ...codebase.editorLayout, view: "code" },
  };
  const onStoryMapShown = vi.fn();
  await renderEditor({ showStoryMap: true, onStoryMapShown });
  expect(
    container.querySelector<HTMLElement>("[data-active-tab]")!.dataset
      .activeTab,
  ).toBe("canvas");
  expect(onStoryMapShown).toHaveBeenCalledOnce();

  await renderWorkspace({ showStoryMap: false, onStoryMapShown });
  const code = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Code",
  )!;
  await act(async () => code.click());
  await renderWorkspace({
    workspaceRevision: 1,
    showStoryMap: false,
    onStoryMapShown,
  });
  expect(
    container.querySelector<HTMLElement>("[data-active-tab]")!.dataset
      .activeTab,
  ).toBe("code");
  expect(onStoryMapShown).toHaveBeenCalledOnce();

  await renderWorkspace({
    workspaceRevision: 1,
    showStoryMap: true,
    onStoryMapShown,
  });
  expect(
    container.querySelector<HTMLElement>("[data-active-tab]")!.dataset
      .activeTab,
  ).toBe("canvas");
  expect(onStoryMapShown).toHaveBeenCalledTimes(2);
});

it("upgrades a story made before web stories once, as soon as the editor has it open", async () => {
  expect(upgradeStory).toHaveBeenCalledExactlyOnceWith("p");
  await renderWorkspace({ workspaceRevision: 1 });
  expect(upgradeStory).toHaveBeenCalledOnce();
  expect(container.querySelector(".story-upgrade-notice")).toBeNull();
});

it("says why an upgrade failed and tries again when asked", async () => {
  await act(async () => root.unmount());
  container.remove();
  upgradeStory.mockReset().mockRejectedValueOnce(new Error("Wait for agents to finish first."));
  await renderEditor();
  const notice = container.querySelector(".story-upgrade-notice");
  expect(notice?.textContent).toContain("Wait for agents to finish first.");
  await act(async () => notice!.querySelector<HTMLButtonElement>("button")!.click());
  expect(upgradeStory).toHaveBeenCalledTimes(2);
});
