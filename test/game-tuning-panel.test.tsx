// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameTuningState } from "../src/shared/game-tuning.js";

const api = vi.hoisted(() => ({
  getGameTuning: vi.fn(),
  setGameTuningDraft: vi.fn(),
  saveGameTuning: vi.fn(),
  undoProjectPluginChange: vi.fn(),
}));
vi.mock("../src/renderer/api.js", () => api);
import { GameTuningPanel } from "../src/renderer/game-tuning-panel.js";

const STATE: GameTuningState = {
  sequence: 1,
  file: "tuning.json",
  connected: true,
  draft: {},
  values: [
    { id: "jump", label: "Jump", value: 420, min: 100, max: 800, step: 10 },
    { id: "fly", label: "Fly", value: false },
  ],
};
const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  api.getGameTuning.mockResolvedValue(STATE);
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
});

async function show(props: Partial<Parameters<typeof GameTuningPanel>[0]> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const onAskAgent = vi.fn();
  const render = (next: Partial<Parameters<typeof GameTuningPanel>[0]> = {}) => act(async () => {
    root.render(<GameTuningPanel projectId="p" previewReady revision={0} onAskAgent={onAskAgent} onClose={() => {}} {...props} {...next} />);
  });
  await render();
  return { host, onAskAgent, render };
}
const button = (host: Element, name: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name)!;
async function drag(host: Element, value: number) {
  const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(slider, String(value));
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the tuning panel", () => {
  it("offers to set tuning up when there is nothing to tune", async () => {
    api.getGameTuning.mockResolvedValue({ values: [], draft: {}, connected: false });
    const { host, onAskAgent } = await show();
    await act(async () => button(host, "Ask the AI to set this up").click());
    expect(onAskAgent.mock.lastCall?.[0]).toContain("window.__OHMYGAME_TUNING__");
  });

  it("says why a file can't be used, keeps it out of sight, and offers a fix", async () => {
    api.getGameTuning.mockResolvedValue({ ...STATE, error: "It isn't valid JSON." });
    const { host, onAskAgent } = await show();
    expect(host.textContent).toContain("tuning.json can't be used");
    expect(host.querySelector('input[type="range"]')).toBeNull();
    await act(async () => button(host, "Ask the AI to fix it").click());
    expect(onAskAgent.mock.lastCall?.[0]).toContain("It isn't valid JSON.");
  });

  it("says when the game isn't listening or running", async () => {
    api.getGameTuning.mockResolvedValue({ ...STATE, connected: false });
    expect((await show()).host.textContent).toContain("The game isn't listening yet");
    expect((await show({ previewReady: false })).host.textContent).toContain("Start the game");
  });

  it("sends only a dragged slider's latest value, one request at a time", async () => {
    let answer!: (state: GameTuningState) => void;
    api.setGameTuningDraft.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { host, render } = await show();
    await drag(host, 500);
    await drag(host, 510);
    await drag(host, 520);
    expect(api.setGameTuningDraft.mock.calls).toEqual([["p", { jump: 500 }]]);
    expect(host.querySelector("output")?.textContent).toBe("520");

    // An older announcement can't move the slider back.
    await render({ announced: { ...STATE, draft: { jump: 500 } } });
    expect(host.querySelector("output")?.textContent).toBe("520");

    await act(async () => answer({ ...STATE, draft: { jump: 500 } }));
    expect(api.setGameTuningDraft.mock.calls[1]).toEqual(["p", { jump: 520 }]);
    await act(async () => answer({ ...STATE, draft: { jump: 520 } }));
    expect(api.setGameTuningDraft).toHaveBeenCalledTimes(2);
    expect(host.querySelector("output")?.textContent).toBe("520");
    expect(host.textContent).toContain("1 changed");
  });

  it("sends the last moves before saving", async () => {
    let answer!: (state: GameTuningState) => void;
    api.setGameTuningDraft.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    api.saveGameTuning.mockResolvedValue({ state: STATE });
    const { host } = await show();
    await drag(host, 500);
    await drag(host, 520);
    await act(async () => button(host, "Save").click());
    expect(api.saveGameTuning).not.toHaveBeenCalled();
    await act(async () => answer({ ...STATE, draft: { jump: 500 } }));
    expect(api.setGameTuningDraft.mock.lastCall).toEqual(["p", { jump: 520 }]);
    expect(api.saveGameTuning).not.toHaveBeenCalled();
    await act(async () => answer({ ...STATE, draft: { jump: 520 } }));
    expect(api.saveGameTuning).toHaveBeenCalledOnce();
  });

  it("keeps sending and saving after a save with nothing left to send", async () => {
    api.setGameTuningDraft.mockImplementation(async (_project: string, values: Record<string, number>) => ({ ...STATE, draft: values }));
    api.saveGameTuning.mockResolvedValue({ state: STATE });
    const { host } = await show();
    await drag(host, 500);
    await act(async () => button(host, "Save").click());
    await drag(host, 600);
    expect(api.setGameTuningDraft.mock.lastCall).toEqual(["p", { jump: 600 }]);
    await drag(host, 610);
    expect(api.setGameTuningDraft.mock.lastCall).toEqual(["p", { jump: 610 }]);
    await act(async () => button(host, "Save").click());
    expect(api.saveGameTuning).toHaveBeenCalledTimes(2);
  });

  it("doesn't save when the last moves failed", async () => {
    let refuse!: (cause: Error) => void;
    api.setGameTuningDraft.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const { host } = await show();
    await drag(host, 500);
    await act(async () => button(host, "Save").click());
    await act(async () => refuse(new Error("The daemon is gone")));
    expect(api.saveGameTuning).not.toHaveBeenCalled();
  });

  it("ignores a read that started before newer news", async () => {
    const { host, render } = await show();
    let answer!: (state: GameTuningState) => void;
    api.getGameTuning.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await render({ revision: 1 });
    await render({ announced: { ...STATE, sequence: 2, draft: { jump: 500 } } });
    expect(host.querySelector("output")?.textContent).toBe("500");
    await act(async () => answer(STATE));
    expect(host.querySelector("output")?.textContent).toBe("500");
  });

  it("ignores an answer to a move when newer news came first", async () => {
    let answer!: (state: GameTuningState) => void;
    api.setGameTuningDraft.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const { host, render } = await show();
    await drag(host, 600);
    // The file's range shrank while the move was on its way.
    await render({ announced: { ...STATE, sequence: 3, values: [{ id: "jump", label: "Jump", value: 420, min: 100, max: 500 }], draft: { jump: 500 } } });
    await act(async () => answer({ ...STATE, sequence: 2, draft: { jump: 600 } }));
    expect(host.querySelector("output")?.textContent).toBe("500");
    expect(host.querySelector<HTMLInputElement>('input[type="range"]')?.max).toBe("500");
  });

  it("goes back to one saved value or all of them", async () => {
    api.getGameTuning.mockResolvedValue({ ...STATE, draft: { jump: 500, fly: true } });
    api.setGameTuningDraft.mockImplementation(async () => ({ ...STATE, draft: { fly: true } }));
    const { host } = await show();
    await act(async () => button(host, "Go back to Jump's saved value").click());
    expect(api.setGameTuningDraft.mock.lastCall).toEqual(["p", { jump: null }]);

    api.setGameTuningDraft.mockImplementation(async () => STATE);
    await act(async () => button(host, "Revert").click());
    expect(api.setGameTuningDraft.mock.lastCall).toEqual(["p", { fly: null }]);
    expect((button(host, "Save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves, then offers to undo that save", async () => {
    api.getGameTuning.mockResolvedValue({ ...STATE, draft: { jump: 500 } });
    api.saveGameTuning.mockResolvedValue({ state: { ...STATE, draft: {} }, changeId: "change" });
    const { host } = await show();
    await act(async () => button(host, "Save").click());
    expect(host.textContent).toContain("Saved to tuning.json");

    api.getGameTuning.mockResolvedValue(STATE);
    await act(async () => button(host, "Undo").click());
    expect(api.undoProjectPluginChange).toHaveBeenCalledWith("p", "change");
    expect(host.textContent).toContain("Save undone");
  });

  it("shows why a save was refused and keeps the changes", async () => {
    api.getGameTuning.mockResolvedValue({ ...STATE, draft: { jump: 500 } });
    api.saveGameTuning.mockRejectedValue(new Error("Wait for the agent, generation jobs and publishing to finish first."));
    const { host } = await show();
    await act(async () => button(host, "Save").click());
    expect(host.textContent).toContain("Wait for the agent");
    expect(host.textContent).toContain("1 changed");
  });
});
