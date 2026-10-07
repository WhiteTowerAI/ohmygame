import { describe, expect, it, vi } from "vitest";
import { OwnedPlaytestDriver } from "../src/daemon/owned-playtest.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter, type PlaytestRequest, type PlaytestResult } from "../src/shared/playtest.js";

function driver() {
  let nextId = 1;
  const request = vi.fn(async (input: PlaytestRequest): Promise<PlaytestResult> => {
    if (input.operation === "open") return { operation: "open", snapshot: { sessionId: `session-${nextId++}`, runtime: "web",
      capabilities: WEB_GAME_USE_CAPABILITIES, viewport: input.viewport } };
    return { operation: "close" };
  });
  return { available: true, capabilities: WEB_GAME_USE_CAPABILITIES, request, close: vi.fn() } satisfies GameRuntimeAdapter;
}
const open: PlaytestRequest = { operation: "open", target: { runtime: "web", url: "http://127.0.0.1:1234" }, viewport: { width: 1280, height: 720 } };

describe("agent-owned Playtest", () => {
  it("cleans only its own sessions and permits reuse in a later run", async () => {
    const shared = driver();
    const first = new OwnedPlaytestDriver(shared);
    const second = new OwnedPlaytestDriver(shared);
    await first.request(open);
    await second.request(open);
    await first.cleanup();
    expect(shared.request.mock.calls.at(-1)).toEqual([{ operation: "close", sessionId: "session-1" }]);
    await expect(first.request({ operation: "close", sessionId: "session-2" })).rejects.toThrow("belong");
    expect(shared.close).not.toHaveBeenCalled();
    await first.request(open);
    await first.cleanup();
    expect(shared.request.mock.calls.at(-1)).toEqual([{ operation: "close", sessionId: "session-3" }]);
    await second.cleanup();
  });

  it("waits for in-flight open requests before closing their windows", async () => {
    const shared = driver();
    let finish!: (result: PlaytestResult) => void;
    shared.request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const owned = new OwnedPlaytestDriver(shared);
    const opening = owned.request(open);
    const cleaning = owned.cleanup();
    finish({ operation: "open", snapshot: { sessionId: "late", runtime: "web", capabilities: WEB_GAME_USE_CAPABILITIES, viewport: open.viewport } });
    await opening;
    await cleaning;
    expect(shared.request.mock.calls.at(-1)).toEqual([{ operation: "close", sessionId: "late" }]);
  });

  it("attempts every close and retries failed cleanup without closing the shared driver", async () => {
    const shared = driver();
    const owned = new OwnedPlaytestDriver(shared);
    await owned.request(open);
    await owned.request(open);
    shared.request.mockRejectedValueOnce(new Error("Temporary failure"));
    await owned.cleanup();
    await owned.cleanup();
    expect(shared.request.mock.calls.slice(2).map(([request]) => request)).toEqual([
      { operation: "close", sessionId: "session-1" }, { operation: "close", sessionId: "session-2" },
      { operation: "close", sessionId: "session-1" },
    ]);
  });
});
