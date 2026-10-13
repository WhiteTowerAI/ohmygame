import { previewPagePath } from "../src/shared/preview-page.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserGamePlayers } from "../src/renderer/use-web-game-player.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const request = { path: "/play#scene", viewport: { width: 375, height: 667 } };
function popup() {
  return {
    closed: false,
    opener: {},
    location: { href: "about:blank" },
    focus: vi.fn(),
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
  };
}

describe("browser game players", () => {
  it("opens synchronously, reuses the popup, and reports a closed player without stopping the server", async () => {
    vi.useFakeTimers();
    const window = popup();
    const open = vi.fn(() => window);
    vi.stubGlobal("window", { open });
    const fetch = vi.fn(async () =>
      Response.json({ url: "http://127.0.0.1:43123" }),
    );
    vi.stubGlobal("fetch", fetch);
    const players = new BrowserGamePlayers();
    const states = vi.fn();
    const unsubscribe = players.onState(states);
    const pending = players.open("game", request);
    expect(open).toHaveBeenCalledOnce();
    expect(window.opener).toBeNull();
    await pending;
    expect(new URL(window.location.href).origin).toBe("http://127.0.0.1:43123");
    expect(previewPagePath(window.location.href)).toBe("/play#scene");
    await players.open("game", { ...request, path: "/different" });
    expect(open).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(new URL(window.location.href).origin).toBe("http://127.0.0.1:43123");
    expect(previewPagePath(window.location.href)).toBe("/play#scene");
    window.close();
    vi.advanceTimersByTime(500);
    expect(await players.state("game")).toEqual({
      projectId: "game",
      open: false,
    });
    expect(states.mock.calls.map(([state]) => state.open)).toEqual([
      true,
      false,
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    unsubscribe();
  });

  it("recovers from blocked popups and failed startup without retaining a blank game", async () => {
    vi.useFakeTimers();
    const window = popup();
    const open = vi.fn().mockReturnValueOnce(null).mockReturnValue(window);
    vi.stubGlobal("window", { open });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Server failed" }, { status: 500 }),
      ),
    );
    const players = new BrowserGamePlayers();
    await expect(players.open("game", request)).rejects.toThrow("Allow popups");
    expect((await players.state("game")).open).toBe(false);
    await expect(players.open("game", request)).rejects.toThrow(
      "Server failed",
    );
    expect(window.closed).toBe(true);
    expect((await players.state("game")).open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves reported scene changes when a stable preview origin restarts", async () => {
    vi.useFakeTimers();
    const window = popup();
    vi.stubGlobal("window", { open: () => window });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ url: "http://127.0.0.1:43123" })),
    );
    const players = new BrowserGamePlayers();
    await players.open("game", request);
    const client = new URL(window.location.href).searchParams.get(
      "__ohmygame_client",
    );
    players.observePath("game", "/scene-2?level=2#boss");
    expect(previewPagePath(window.location.href)).toBe("/play#scene");
    await players.refresh("game", true);
    expect(previewPagePath(window.location.href)).toBe("/scene-2?level=2#boss");
    expect(
      new URL(window.location.href).searchParams.get("__ohmygame_client"),
    ).toBe(client);
    await players.close("game");
    expect(vi.getTimerCount()).toBe(0);
  });
});
