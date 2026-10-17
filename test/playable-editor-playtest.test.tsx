// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import { desktopSave } from "../src/renderer/desktop-save.js";
import { takePlaytestRequest } from "../src/renderer/playable-playtest.js";

const codebase = createStarterCodebaseWithScene("Playtest", {
  width: 1280,
  height: 720,
});
const update = vi.fn(async () => ({ revision: "saved" }));
let move!: (
  event: unknown,
  viewport: { x: number; y: number; zoom: number },
) => void;
vi.doMock(path.resolve("src/renderer/editor-canvas.tsx"), async (original) => ({
  ...(await original<typeof import("../src/renderer/editor-canvas.js")>()),
  EditorCanvas: (props: { onMoveEnd: typeof move }) => {
    move = props.onMoveEnd;
    return <div />;
  },
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeCodebase: async () => ({
    ...structuredClone(codebase),
    revision: "disk",
  }),
  listPlayablePresets: async () => ({ presets: [] }),
  listPlayableThumbnails: async () => ({}),
  getPlayableValidation: async () => ({ issues: [] }),
  updateNodeCodebase: update,
}));
const { PlayableEditorWorkspace } =
  await import("../src/renderer/playable-editor-workspace.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  update.mockReset().mockResolvedValue({ revision: "saved" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PlayableEditorWorkspace
        project={{ id: "p", type: "interactive-story" } as ProjectState}
        agentBusy={false}
        publishing={false}
        onPublish={async () => false}
        onOpenPublish={() => {}}
        onClosePublish={() => {}}
      />,
    ),
  );
  await act(async () => move(null, { x: 32, y: 64, zoom: 1.2 }));
});
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
