// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRecordingBridge, GameRecordingState } from "../src/shared/game-recording.js";

const toast = vi.hoisted(() => vi.fn());
vi.mock("../src/renderer/ui/index.js", async (original) => ({ ...await original<typeof import("../src/renderer/ui/index.js")>(), useToast: () => toast }));
import { GameRecordStatus, GameRecordingNotices, recordMenuItem, useGameRecording } from "../src/renderer/game-recording.js";

/** What the game's toolbar shows: the ··· menu's item that starts a recording, and the one under way. */
function GameRecordButton({ projectId, gameRunning }: { projectId: string; gameRunning: boolean }) {
  const recording = useGameRecording(projectId);
  const item = recordMenuItem(recording, gameRunning);
  return <>
    {item ? <button type="button" className="record-item" onClick={item.onSelect}>{item.label}</button> : null}
    <GameRecordStatus recording={recording} />
  </>;
}

let listeners: ((state: GameRecordingState) => void)[] = [];
const bridge = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  state: vi.fn(async (projectId: string): Promise<GameRecordingState> => ({ projectId, status: "idle" })),
  onState: vi.fn((listener: (state: GameRecordingState) => void) => {
    listeners.push(listener);
    return () => { listeners = listeners.filter((entry) => entry !== listener); };
  }),
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

describe("game recording", () => {
  it("is absent where a game can't be recorded", async () => {
    delete (window as unknown as { ohMyGameDesktop?: unknown }).ohMyGameDesktop;
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    expect(host.querySelector(".record-item, .preview-record-button")).toBeNull();
  });

  it("offers to record only once the game runs, and shows nothing beside Play until then", async () => {
    const host = await render(<GameRecordButton projectId="p" gameRunning={false} />);
    expect(host.querySelector(".record-item")).toBeNull();
    await act(async () => { roots.at(-1)!.render(<GameRecordButton projectId="p" gameRunning />); });
    expect(host.querySelector(".record-item")).not.toBeNull();
    expect(host.querySelector(".preview-record-button")).toBeNull();
  });

  it("starts, shows the time, stops, and shows that it is saving", async () => {
    const host = await render(<GameRecordButton projectId="p" gameRunning />);
    await act(async () => { host.querySelector<HTMLButtonElement>(".record-item")!.click(); });
    expect(bridge.start).toHaveBeenCalledWith("p");
    await announce({ projectId: "p", status: "recording", startedAt: Date.now() - 65_000, maxSeconds: 300 });
    expect(host.querySelector(".record-item")).toBeNull();
    const recording = host.querySelector<HTMLButtonElement>(".preview-record-button.is-recording")!;
    expect(recording.textContent).toContain("1:05");
    await act(async () => { recording.click(); });
    expect(bridge.stop).toHaveBeenCalledWith("p");
    await announce({ projectId: "p", status: "saving" });
    expect(host.querySelector<HTMLButtonElement>(".preview-record-button")!.disabled).toBe(true);
    await announce({ projectId: "p", status: "idle", saved: { path: ".ohmygame/media/imported/game.mp4", name: "game.mp4", duration: 3, bytes: 9 } });
    expect(host.querySelector(".preview-record-button")).toBeNull();
    expect(host.querySelector(".record-item")).not.toBeNull();
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
    await act(async () => { host.querySelector<HTMLButtonElement>(".record-item")!.click(); });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: "The game preview is unavailable.", tone: "danger" }));
    expect(host.querySelector(".record-item")).not.toBeNull();
  });
});

describe("game recording notices", () => {
  it("announces each outcome", async () => {
    await render(<GameRecordingNotices />);
    await announce({ projectId: "p", status: "recording", startedAt: 1 });
    await announce({ projectId: "p", status: "saving" });
    expect(toast).not.toHaveBeenCalled();
    await announce({ projectId: "p", status: "idle", saved: { path: ".ohmygame/media/imported/game.mp4", name: "game.mp4", duration: 3, bytes: 9 } });
    expect(toast).toHaveBeenCalledOnce();
    expect(toast.mock.calls[0]![0]).toMatchObject({ title: "Recording saved to the project's assets", description: "game.mp4" });
    await announce({ projectId: "p", status: "idle", error: "Disk full" });
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: "Disk full", tone: "danger" }));
  });
});
