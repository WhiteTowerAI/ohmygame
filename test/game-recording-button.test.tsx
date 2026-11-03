// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRecordingBridge, GameRecordingState } from "../src/shared/game-recording.js";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/ui/index.js", async (original) => ({ ...await original<typeof import("../src/renderer/ui/index.js")>(), useToast: () => toast }));
import { GameRecordButton, GameRecordingNotices } from "../src/renderer/game-recording.js";

let listeners: ((state: GameRecordingState) => void)[] = [];
const bridge = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  state: vi.fn(async (projectId: string): Promise<GameRecordingState> => ({ projectId, status: "idle" })),
  onState: vi.fn((listener: (state: GameRecordingState) => void) => {
    listeners.push(listener);
    return () => { listeners = listeners.filter((entry) => entry !== listener); };
  }),
  onSaved: vi.fn(() => () => {}),
} satisfies GameRecordingBridge;
const roots: ReturnType<typeof createRoot>[] = [];
async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(node); });
  return host;
}
const announce = (state: GameRecordingState) => act(async () => { for (const listener of listeners) listener(state); });

beforeEach(() => {
  listeners = [];
  toast.mockReset();
  for (const mock of [bridge.start, bridge.stop, bridge.state, bridge.onState]) mock.mockClear();
  bridge.start.mockImplementation(async () => {});
  bridge.state.mockImplementation(async (projectId) => ({ projectId, status: "idle" }));
  (window as unknown as { ohMyGameDesktop: unknown }).ohMyGameDesktop = { webGamePlayer: { recording: bridge } };
});
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.innerHTML = "";
  delete (window as unknown as { ohMyGameDesktop?: unknown }).ohMyGameDesktop;
});

describe("game record button", () => {
  it("is absent where a game can't be recorded", async () => {
    delete (window as unknown as { ohMyGameDesktop?: unknown }).ohMyGameDesktop;
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    expect(host.querySelector(".preview-record-button")).toBeNull();
  });

  it("can't start until the game runs", async () => {
    const host = await render(<GameRecordButton projectId="p" gameRunning={false} />);
    expect(host.querySelector<HTMLButtonElement>(".preview-record-button")!.disabled).toBe(true);
  });

  it("starts, shows the time, stops, and shows that it is saving", async () => {
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    await act(async () => { host.querySelector<HTMLButtonElement>(".preview-record-button")!.click(); });
    expect(bridge.start).toHaveBeenCalledWith("p");
    await announce({ projectId: "p", status: "recording", startedAt: Date.now() - 65_000, maxSeconds: 300 });
    const recording = host.querySelector<HTMLButtonElement>(".preview-record-button.is-recording")!;
    expect(recording.textContent).toContain("1:05");
    await act(async () => { recording.click(); });
    expect(bridge.stop).toHaveBeenCalledWith("p");
    await announce({ projectId: "p", status: "saving" });
    expect(host.querySelector<HTMLButtonElement>(".preview-record-button")!.disabled).toBe(true);
    await announce({ projectId: "p", status: "idle", saved: { assetId: "a", name: "game.mp4", duration: 3, bytes: 9 } });
    expect(host.querySelector(".is-recording")).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".preview-record-button")!.disabled).toBe(false);
  });

  it("picks up a recording already running and ignores other projects'", async () => {
    bridge.state.mockImplementation(async (projectId) => ({ projectId, status: "recording", startedAt: Date.now(), maxSeconds: 300 }));
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    expect(host.querySelector(".is-recording")).not.toBeNull();
    await announce({ projectId: "other", status: "idle" });
    expect(host.querySelector(".is-recording")).not.toBeNull();
  });

  it("says why recording could not start, without the IPC wrapping", async () => {
    bridge.start.mockRejectedValue(new Error("Error invoking remote method 'ohmygame:start-game-recording': Error: The game preview is unavailable."));
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    await act(async () => { host.querySelector<HTMLButtonElement>(".preview-record-button")!.click(); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: "The game preview is unavailable.", tone: "danger" }));
    expect(host.querySelector<HTMLButtonElement>(".preview-record-button")!.disabled).toBe(false);
  });
});

describe("game recording notices", () => {
  it("announces each outcome, and offers the Library for a saved one", async () => {
    await render(<GameRecordingNotices />);
    await announce({ projectId: "p", status: "recording", startedAt: 1 });
    await announce({ projectId: "p", status: "saving" });
    expect(toast).not.toHaveBeenCalled();
    await announce({ projectId: "p", status: "idle", saved: { assetId: "a", name: "game.mp4", duration: 3, bytes: 9 } });
    expect(toast).toHaveBeenCalledOnce();
    expect(toast.mock.calls[0]![0]).toMatchObject({ description: "game.mp4" });
    toast.mock.calls[0]![0].action.onClick();
    expect(window.location.hash).toBe("#/library");
    await announce({ projectId: "p", status: "idle", error: "Disk full" });
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "Disk full", tone: "danger" }));
  });
});
