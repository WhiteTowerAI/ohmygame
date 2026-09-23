import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessPlaytestDriver } from "../src/daemon/playtest-driver.js";
import type { PlaytestIpcMessage } from "../src/shared/playtest.js";

class FakeIpc extends EventEmitter {
  connected = true;
  readonly sent: PlaytestIpcMessage[] = [];

  send(message: PlaytestIpcMessage, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    callback?.(null);
    return true;
  }
}

describe("process playtest driver", () => {
  it("correlates desktop responses with requests", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request({ operation: "close", sessionId: "session-1" });
    const request = ipc.sent[0];
    if (request?.channel !== "ohmygame:playtest-request") throw new Error("Expected request");

    ipc.emit("message", {
      channel: "ohmygame:playtest-response",
      id: request.id,
      result: { operation: "close" },
    } satisfies PlaytestIpcMessage);

    await expect(result).resolves.toEqual({ operation: "close" });
    driver.close();
  });

  it("cancels the desktop request when the agent aborts", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const controller = new AbortController();
    const result = driver.request({ operation: "inspect", sessionId: "session-1" }, controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ipc.sent.map((message) => message.channel)).toEqual([
      "ohmygame:playtest-request",
      "ohmygame:playtest-cancel",
    ]);
    driver.close();
  });

  it("fails pending work when desktop disconnects", async () => {
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc);
    const result = driver.request({ operation: "inspect", sessionId: "session-1" });
    ipc.connected = false;
    ipc.emit("disconnect");

    await expect(result).rejects.toThrow("disconnected");
    expect(driver.available).toBe(false);
    driver.close();
  });

  it("times out requests that never receive a response", async () => {
    vi.useFakeTimers();
    const ipc = new FakeIpc();
    const driver = new ProcessPlaytestDriver(ipc, 25);
    const result = driver.request({ operation: "inspect", sessionId: "session-1" });
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(ipc.sent.at(-1)?.channel).toBe("ohmygame:playtest-cancel");
    driver.close();
    vi.useRealTimers();
  });
});
