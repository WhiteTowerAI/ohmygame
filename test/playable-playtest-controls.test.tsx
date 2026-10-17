// @vitest-environment happy-dom
import path from "node:path";
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodePlayerDefinition } from "../src/shared/playable-player-protocol.js";
import { createStarterCodebaseWithScene } from "./playable-fixture.js";
import {
  PlaytestControls,
  playtestSaveKey,
  playtestSeenKey,
  requestPlaytest,
  takePlaytestRequest,
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
  compiled: { version: 1, nodes: {} },
};
const player = vi.fn();
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  getNodeRuntime: async () => ({ available: true, definition }),
}));
vi.doMock(path.resolve("src/renderer/playable-assets.ts"), () => ({
  loadPlayableAssets: async () => ({}),
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
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  player.mockClear();
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

function button(label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function deliverAction(action: PlaytestAction, projectId = "p") {
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
    window.localStorage.setItem(playtestSaveKey("p"), "saved game");
    window.localStorage.setItem(playtestSeenKey("p"), "explored scenes");
    requestPlaytest("p", { action: "replay" });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    expect(window.localStorage.getItem(playtestSaveKey("p"))).toBeNull();
    expect(window.localStorage.getItem(playtestSeenKey("p"))).toBe(
      "explored scenes",
    );
    expect(player.mock.calls.at(-1)?.[0].preview).toBeUndefined();
    expect(container.querySelector(".playable-playtest-corner")).toBeNull();
    expect(container.querySelector(".window-drag-region")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });

  it("handles actions in an already open window and ignores other projects", async () => {
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    window.localStorage.setItem(playtestSaveKey("p"), "saved game");
    window.localStorage.setItem(playtestSeenKey("p"), "explored scenes");
    const calls = player.mock.calls.length;
    await deliverAction("replay", "other");
    expect(player).toHaveBeenCalledTimes(calls);
    await deliverAction("forget-seen");
    expect(window.localStorage.getItem(playtestSaveKey("p"))).toBe(
      "saved game",
    );
    expect(window.localStorage.getItem(playtestSeenKey("p"))).toBeNull();
    expect(player.mock.calls.length).toBeGreaterThan(calls);
    await deliverAction("replay");
    expect(window.localStorage.getItem(playtestSaveKey("p"))).toBeNull();
    expect(takePlaytestRequest("p")).toBeUndefined();
  });

  it("replays a chosen Scene with fresh session storage and preserves the project's save", async () => {
    window.localStorage.setItem(playtestSaveKey("p"), "saved game");
    window.localStorage.setItem(playtestSeenKey("p"), "explored scenes");
    requestPlaytest("p", { action: "start", start: { nodeId: "archive" } });
    await act(async () => root.render(<PlaytestPage projectId="p" />));
    const initial = player.mock.calls.at(-1)![0];
    expect(initial.preview).toEqual({
      policy: "follow",
      startNodeId: "archive",
    });
    await deliverAction("replay");
    const replay = player.mock.calls.at(-1)![0];
    expect(replay.preview).toEqual(initial.preview);
    expect(replay.storage).not.toBe(initial.storage);
    expect(window.localStorage.getItem(playtestSaveKey("p"))).toBe(
      "saved game",
    );
    expect(window.localStorage.getItem(playtestSeenKey("p"))).toBe(
      "explored scenes",
    );
    await deliverAction("forget-seen");
    expect(player.mock.calls.at(-1)![0].preview).toEqual(initial.preview);
    expect(window.localStorage.getItem(playtestSaveKey("p"))).toBe(
      "saved game",
    );
    expect(window.localStorage.getItem(playtestSeenKey("p"))).toBeNull();
  });
});
