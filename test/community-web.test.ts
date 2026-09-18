import { describe, expect, it, vi } from "vitest";
import { getCommunityGame, listCommunityGames } from "../src/community-web/api.js";
import { getGameMosaicSlots, parseCommunityRoute } from "../src/community-web/app.js";

describe("Community Web routes", () => {
  it("parses home and game detail paths", () => {
    expect(parseCommunityRoute("/")).toEqual({ page: "home" });
    expect(parseCommunityRoute("/games/game%201")).toEqual({ page: "game", gameId: "game 1" });
    expect(parseCommunityRoute("/games/game-1/")).toEqual({ page: "game", gameId: "game-1" });
    expect(parseCommunityRoute("/games")).toEqual({ page: "not-found" });
    expect(parseCommunityRoute("/games/%")).toEqual({ page: "not-found" });
    expect(parseCommunityRoute("/pricing")).toEqual({ page: "account", section: "plans" });
    expect(parseCommunityRoute("/account/usage")).toEqual({ page: "account", section: "usage" });
    expect(parseCommunityRoute("/plans")).toEqual({ page: "not-found" });
    expect(parseCommunityRoute("/usage")).toEqual({ page: "not-found" });
    expect(parseCommunityRoute("/billing")).toEqual({ page: "not-found" });
  });
});

describe("Community Web game mosaic", () => {
  it("fills the complete desktop mosaic without overlaps", () => {
    const occupied = new Set<string>();
    const slots = getGameMosaicSlots(28);

    expect(slots).toHaveLength(28);
    for (const slot of slots) {
      for (let row = slot.row; row < slot.row + slot.size; row += 1) {
        for (let column = slot.column; column < slot.column + slot.size; column += 1) {
          const cell = `${column}:${row}`;
          expect(occupied.has(cell)).toBe(false);
          occupied.add(cell);
        }
      }
    }
    expect(occupied.size).toBe(85);
    expect(Math.max(...slots.map((slot) => slot.column + slot.size - 1))).toBe(10);
  });

  it("returns only available slots for an incomplete wall", () => {
    expect(getGameMosaicSlots(3)).toHaveLength(3);
    expect(getGameMosaicSlots(100)).toHaveLength(28);
    expect(getGameMosaicSlots(-1)).toEqual([]);
  });

});

describe("Community Web API", () => {
  it("loads listed games", async () => {
    const first = game("first");
    const second = game("second");
    const fetcher = vi.fn(async () => Response.json([first, second]));

    await expect(listCommunityGames(fetcher)).resolves.toEqual([first, second]);
    expect(fetcher).toHaveBeenCalledWith("/v1/community/games", expect.anything());
  });

  it("loads a game by encoded id", async () => {
    const expected = game("game 1");
    const fetcher = vi.fn(async () => Response.json(expected));

    await expect(getCommunityGame(expected.id, fetcher)).resolves.toEqual(expected);
    expect(fetcher).toHaveBeenCalledWith("/v1/community/games/game%201", expect.anything());
  });

  it("surfaces nested and top-level API error messages", async () => {
    const nested = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Nested failure" } }), { status: 500 }));
    const topLevel = vi.fn(async () => new Response(JSON.stringify({ message: "Upstream unavailable" }), { status: 404 }));

    await expect(listCommunityGames(nested)).rejects.toThrow("Nested failure");
    await expect(listCommunityGames(topLevel)).rejects.toThrow("Upstream unavailable");
  });
});

function game(id: string) {
  return {
    id,
    title: id,
    description: "",
    deploymentId: `deployment-${id}`,
    playUrl: `https://${id}.play.example`,
    publishedAt: "2026-08-13T00:00:00.000Z",
  };
}
