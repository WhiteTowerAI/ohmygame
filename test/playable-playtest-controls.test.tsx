// @vitest-environment happy-dom
import path from "node:path";
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import type { NodeRuntimeSnapshot } from "../src/shared/playable-runtime.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import {
  PlaytestControls,
  requestPlaytest,
  takePlaytestRequest,
  requestAskAgent,
  usePlaytestAskRequests,
  type PlaytestAction,
} from "../src/renderer/playable-playtest.js";

const codebase = createStarterCodebaseWithScene("Playtest", {
  width: 1280,
  height: 720,
});
const definition: NodePlayerDefinition = {
  version: 1,
  graph: codebase.graph,
  graphSignature: "playtest",
  hashes: {},
};
const player = vi.fn();
const getNodeRuntime = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeRuntime,
  ensureProjectPreview: async () => ({ url: "http://127.0.0.1:5555/index.html", title: "Playtest" }),
}));
vi.doMock(
  path.resolve("src/renderer/playable-player.tsx"),
  async (original) => ({
    ...(await original<typeof import("../src/renderer/playable-player.js")>()),
    NodePlayer: (props: unknown) => {
      player(props);
      return <iframe title="Game" />;
    },
  }),
);
const { PlaytestPage } = await import("../src/renderer/playtest.js");
const { ApiError } = await import("../src/renderer/api.js");
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  player.mockClear();
  getNodeRuntime.mockReset().mockResolvedValue({ available: true, definition, web: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await i18next.changeLanguage("en");
  container.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** The query parameters the last Playtest session asked the story's page for. */
function pageParameters(): Record<string, string> {
  return Object.fromEntries(new URL(player.mock.calls.at(-1)![0].page as string).searchParams);
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function deliverAction(action: PlaytestAction | "open", projectId = "p") {
  await act(async () => {
    requestPlaytest(projectId, { action });
    const key = `ohmygame:playtest:request:${projectId}`;
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: window.localStorage.getItem(key),
        storageArea: window.localStorage,
      }),
    );
  });
}

describe("editor Playtest controls", () => {
  it("keeps opening Playtest a single click and sends menu actions separately", async () => {
    const open = vi.fn(),
      action = vi.fn();
    await act(async () =>
      root.render(<PlaytestControls onOpen={open} onAction={action} />),
    );
    await act(async () => button("Playtest").click());
    expect(open).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();

    await act(async () => button("Playtest actions").click());
    const items =
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(Array.from(items, (item) => item.textContent)).toEqual([
      "Replay Playtest",
      "Forget seen Scenes",
    ]);
    await act(async () => items[0]!.click());
    expect(action).toHaveBeenCalledExactlyOnceWith("replay");
    expect(container.querySelector('[role="menu"]')).toBeNull();

    await act(async () => button("Playtest actions").click());
    await act(async () =>
      container
        .querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[1]!
        .click(),
    );
    expect(action).toHaveBeenLastCalledWith("forget-seen");
  });

  it("translates default controls, action titles, and the opening state into Chinese", async () => {
    await i18next.changeLanguage("zh-CN");
    await act(async () =>
      root.render(<PlaytestControls onOpen={() => {}} onAction={() => {}} />),
    );
    expect(button("试玩").dataset.tooltip).toBe("在新窗口中试玩");
    await act(async () => button("试玩操作").click());
    const items =
      container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(Array.from(items, (item) => item.textContent)).toEqual([
      "重新开始试玩",
      "清除已看过的场景",
    ]);
    expect(items[0]!.title).toContain("常规试玩会清除已有存档");
    expect(items[1]!.title).toContain("保留游戏存档");
    await act(async () =>
      root.render(
        <PlaytestControls busy onOpen={() => {}} onAction={() => {}} />,
      ),
    );
    expect(button("试玩").dataset.tooltip).toBe("正在打开试玩…");
  });

  it("supports keyboard navigation and closes on Escape, outside click, or losing focus to a frame", async () => {
    await act(async () =>
      root.render(<PlaytestControls onOpen={() => {}} onAction={() => {}} />),
    );
    const trigger = button("Playtest actions");
    trigger.focus();
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    const items = container.querySelectorAll('[role="menuitem"]');
    expect(document.activeElement).toBe(items[0]);
    await act(async () =>
      items[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(items[1]);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.click());
    await act(async () =>
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      ),
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => trigger.click());
    await act(async () => window.dispatchEvent(new Event("blur")));
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables both entry points while opening and closes a previously open menu", async () => {
    const open = vi.fn(),
      action = vi.fn();
    await act(async () =>
      root.render(<PlaytestControls onOpen={open} onAction={action} />),
    );
    await act(async () => button("Playtest actions").click());
    await act(async () =>
      root.render(<PlaytestControls busy onOpen={open} onAction={action} />),
    );
    expect(button("Playtest").disabled).toBe(true);
    expect(button("Playtest actions").disabled).toBe(true);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("Playtest window requests", () => {
  it("queues requests for a closed window and consumes them only once per project", () => {
    requestPlaytest("p", { action: "start", start: { nodeId: "archive" } });
    requestPlaytest("other", { action: "replay" });
    expect(takePlaytestRequest("p")).toEqual({
      action: "start",
      start: { nodeId: "archive" },
    });
    expect(takePlaytestRequest("p")).toBeUndefined();
    expect(takePlaytestRequest("other")).toEqual({ action: "replay" });
    window.localStorage.setItem(
      "ohmygame:playtest:request:p",
      '{"action":"start","start":null}',
    );
    expect(takePlaytestRequest("p")).toBeUndefined();
    window.localStorage.setItem("ohmygame:playtest:request:p", "null");
    expect(takePlaytestRequest("p")).toBeUndefined();
  });

  it("replays a newly opened game without clearing its exploration record", async () => {
    requestPlaytest("p", { action: "replay" });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    // The page keeps its own saves, so it is asked to start a new game.
    expect(pageParameters()).toEqual({ "ohmygame-new-game": "1" });
    expect(player.mock.calls.at(-1)?.[0].preview).toBeUndefined();
    expect(container.querySelector(".playable-playtest-corner")).toBeNull();
    expect(container.querySelector(".window-drag-region")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("handles actions in an already open window and ignores other projects", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(pageParameters()).toEqual({});
    const calls = player.mock.calls.length;
    await deliverAction("replay", "other");
    expect(player).toHaveBeenCalledTimes(calls);
    await deliverAction("forget-seen");
    expect(pageParameters()).toEqual({ "ohmygame-forget-seen": "1" });
    expect(player.mock.calls.length).toBeGreaterThan(calls);
    await deliverAction("replay");
    expect(pageParameters()).toEqual({ "ohmygame-new-game": "1" });
    expect(takePlaytestRequest("p")).toBeUndefined();
  });

  it("replays a chosen Scene without touching the project's save", async () => {
    requestPlaytest("p", { action: "start", start: { nodeId: "start" } });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const initial = player.mock.calls.at(-1)![0];
    expect(initial.preview).toEqual({
      policy: "follow",
      startNodeId: "start",
    });
    expect(pageParameters()).toEqual({ "ohmygame-save": "none" });
    await deliverAction("replay");
    expect(player.mock.calls.at(-1)![0].preview).toEqual(initial.preview);
    expect(pageParameters()).toEqual({ "ohmygame-save": "none" });
    await deliverAction("forget-seen");
    expect(player.mock.calls.at(-1)![0].preview).toEqual(initial.preview);
    expect(pageParameters()).toEqual({ "ohmygame-forget-seen": "1", "ohmygame-save": "none" });
  });

  it("keeps a playing game when the editor only brings Playtest forward", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const calls = player.mock.calls.length;
    await deliverAction("open");
    expect(getNodeRuntime).toHaveBeenCalledOnce();
    expect(player).toHaveBeenCalledTimes(calls);
  });

  it("lets a window that is still loading finish when the editor brings it forward", async () => {
    getNodeRuntime.mockReturnValue(new Promise(() => {}));
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    await deliverAction("open");
    expect(getNodeRuntime).toHaveBeenCalledOnce();
  });

  it("loads the story again for an editor action or when it could not be played", async () => {
    getNodeRuntime.mockRejectedValueOnce(new Error("The game service is unavailable."));
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(player).not.toHaveBeenCalled();
    await deliverAction("open");
    expect(getNodeRuntime).toHaveBeenCalledTimes(2);
    expect(player).toHaveBeenCalled();
    await deliverAction("replay");
    expect(getNodeRuntime).toHaveBeenCalledTimes(3);
  });
});

describe("Playtest that cannot start", () => {
  const empty: NodePlayerDefinition = {
    ...definition,
    graph: { ...definition.graph, nodes: [], edges: [] },
  };

  function text(): string {
    return container.textContent ?? "";
  }

  function action(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === label,
    );
    if (!found) throw new Error(`Missing action: ${label}`);
    return found;
  }

  it("asks to open a story made before web stories in the editor, which upgrades it", async () => {
    const showPlaytestEditor = vi.fn(async () => {});
    vi.stubGlobal("ohMyGameDesktop", { showPlaytestEditor });
    getNodeRuntime.mockResolvedValue({ available: true, definition });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(player).not.toHaveBeenCalled();
    expect(text()).toContain("This story needs to be upgraded first");
    await act(async () => action("Open editor").click());
    expect(showPlaytestEditor).toHaveBeenCalledWith("p");
  });

  it("says to add a Scene and brings the editor forward instead of starting a story with none", async () => {
    const showPlaytestEditor = vi.fn(async () => {});
    vi.stubGlobal("ohMyGameDesktop", { showPlaytestEditor });
    getNodeRuntime.mockResolvedValue({ available: true, definition: empty, web: true });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(player).not.toHaveBeenCalled();
    expect(text()).toContain("This story has no Scenes yet");
    expect(text()).toContain("Add a Scene in the Story editor, then click Playtest again.");
    await act(async () => action("Open editor").click());
    expect(showPlaytestEditor).toHaveBeenCalledExactlyOnceWith("p");
  });

  it("offers to close the window when nothing can bring the editor forward", async () => {
    getNodeRuntime.mockResolvedValue({ available: false });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("This story has no Scenes yet");
    await act(async () => action("Close window").click());
    expect(close).toHaveBeenCalledOnce();
  });

  it("plays from the start when the chosen Scene no longer exists", async () => {
    requestPlaytest("p", { action: "start", start: { nodeId: "deleted" } });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(player).not.toHaveBeenCalled();
    expect(text()).toContain("The Scene to play from no longer exists");
    await act(async () => action("Play from the start").click());
    expect(player.mock.calls.at(-1)?.[0].preview).toBeUndefined();
  });

  it("asks the AI to fix a story the service refused", async () => {
    getNodeRuntime.mockRejectedValue(new ApiError("/: graph.json is not valid JSON.", 400));
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("The story can't start");
    expect(text()).toContain("/: graph.json is not valid JSON.");
    await act(async () => action("Ask AI to fix").click());
    const ask = JSON.parse(window.localStorage.getItem("ohmygame:playtest:ask:p")!) as { text: string };
    expect(ask.text).toBe("Playtest could not start the story. Find the cause and fix it.\n\nError:\n- /: graph.json is not valid JSON.");
    expect(text()).toContain("Added to the chat in the editor");
    expect(action("Close window")).toBeTruthy();
  });

  it("shows a game that stopped while starting the same way", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    await act(async () => player.mock.calls.at(-1)![0].onError("Scene script failed"));
    expect(text()).toContain("The story can't start");
    expect(text()).toContain("Scene script failed");
    const calls = player.mock.calls.length;
    await act(async () => action("Try again").click());
    expect(getNodeRuntime).toHaveBeenCalledTimes(2);
    expect(player.mock.calls.length).toBeGreaterThan(calls);
    expect(text()).not.toContain("The story can't start");
  });

  it("tells the AI what the game reported before it stopped while starting", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const props = player.mock.calls.at(-1)![0];
    await act(async () => props.onDiagnostic("Missing image"));
    await act(async () => props.onError("Scene script failed"));
    await act(async () => action("Ask AI to fix").click());
    const ask = JSON.parse(window.localStorage.getItem("ohmygame:playtest:ask:p")!) as { text: string };
    expect(ask.text).toBe("Something broke while I was playtesting. Find the cause and fix it.\n\nErrors:\n- Missing image\n- Scene script failed");
  });

  function snapshot(status: NodeRuntimeSnapshot["status"]): NodeRuntimeSnapshot {
    return {
      status,
      policy: "follow",
      currentNodeId: "start",
      backStack: [],
      state: {},
      recentSignals: [],
      reports: [],
      stateAccess: {},
      errors: [],
    } as unknown as NodeRuntimeSnapshot;
  }

  it("still says the story can't start when a web story reported itself before it started", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const props = player.mock.calls.at(-1)![0];
    await act(async () => props.onSnapshot(snapshot("starting")));
    await act(async () => props.onError("Scene script failed"));
    expect(text()).toContain("The story can't start");
    expect(text()).not.toContain("The story stopped with an error");
  });

  it("says the story stopped, not that it could not start, when a running game fails", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const props = player.mock.calls.at(-1)![0];
    await act(async () => props.onSnapshot(snapshot("running")));
    await act(async () => props.onError("The save could not be read"));
    expect(text()).toContain("The story stopped with an error");
    expect(text()).toContain("The save could not be read");
    expect(text()).not.toContain("The story can't start");
    await act(async () => action("Ask AI to fix").click());
    const ask = JSON.parse(window.localStorage.getItem("ohmygame:playtest:ask:p")!) as { text: string };
    expect(ask.text).toBe("Something broke while I was playtesting. Find the cause and fix it.\nI was in Node 1.\n\nErrors:\n- The save could not be read");
    const calls = getNodeRuntime.mock.calls.length;
    await act(async () => action("Play again").click());
    expect(getNodeRuntime).toHaveBeenCalledTimes(calls + 1);
    expect(text()).not.toContain("The story stopped with an error");
    // The new session has not played yet, so failing now is a failure to start.
    await act(async () => player.mock.calls.at(-1)![0].onError("Scene script failed"));
    expect(text()).toContain("The story can't start");
  });

  it("counts a Scene change as playing, and a page that starts over as not yet playing", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const props = player.mock.calls.at(-1)![0];
    await act(async () => props.onSnapshot(snapshot("transitioning")));
    await act(async () => props.onSnapshot(snapshot("starting")));
    await act(async () => props.onError("Scene script failed"));
    expect(text()).toContain("The story can't start");
    await act(async () => action("Try again").click());
    const next = player.mock.calls.at(-1)![0];
    await act(async () => next.onSnapshot(snapshot("transitioning")));
    await act(async () => next.onError("Scene script failed"));
    expect(text()).toContain("The story stopped with an error");
  });

  it("tries again after a failure that may pass, keeping the chosen Scene", async () => {
    getNodeRuntime.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    requestPlaytest("p", { action: "start", start: { nodeId: "start" } });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("Playtest couldn't load the story");
    await act(async () => action("Try again").click());
    expect(player.mock.calls.at(-1)?.[0].preview).toEqual({ policy: "follow", startNodeId: "start" });
  });

  it("does not blame the story's files for a request the service refused for another reason", async () => {
    getNodeRuntime.mockRejectedValue(new ApiError("Unauthorized", 401));
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("Playtest couldn't load the story");
    expect(text()).not.toContain("Ask AI to fix");
  });

  it("offers only to close the window for a project that no longer exists", async () => {
    vi.stubGlobal("ohMyGameDesktop", { showPlaytestEditor: vi.fn() });
    getNodeRuntime.mockRejectedValue(new ApiError("Project not found", 404));
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("This project is no longer available");
    expect(Array.from(container.querySelectorAll("button"), (item) => item.textContent)).toEqual(["Close window"]);
  });

  it("translates the explanation and actions into Chinese", async () => {
    await i18next.changeLanguage("zh-CN");
    getNodeRuntime.mockResolvedValue({ available: true, definition: empty, web: true });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(text()).toContain("这个故事还没有场景");
    expect(action("关闭窗口")).toBeTruthy();
    expect(document.title).toBe("Playtest - Playtest");
  });
});

describe("Ask AI to fix from Playtest", () => {
  function Editor({ onAsk }: { onAsk: (text: string) => void }) {
    usePlaytestAskRequests("p", onAsk);
    return null;
  }

  it("takes a request sent just before the editor opened, but not an old one", async () => {
    requestAskAgent("p", "Fix the start");
    const onAsk = vi.fn();
    await act(async () => root.render(<Editor onAsk={onAsk} />));
    expect(onAsk).toHaveBeenCalledExactlyOnceWith("Fix the start");
    expect(window.localStorage.getItem("ohmygame:playtest:ask:p")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    window.localStorage.setItem("ohmygame:playtest:ask:p", JSON.stringify({ text: "Old", id: Date.now() - 120_000 }));
    const later = vi.fn();
    await act(async () => root.render(<Editor onAsk={later} />));
    expect(later).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("ohmygame:playtest:ask:p")).toBeNull();
  });
});
