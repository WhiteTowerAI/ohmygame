import { describe, expect, it, vi } from "vitest";
import { getCommunityGame, listCommunityGames } from "../src/community-web/api.js";
import { getGameDetailMosaicSlots, getGameMosaicSlots, parseCommunityRoute } from "../src/community-web/app.js";

describe("Community Web routes", () => {
  it("parses home and game detail paths", () => {
    expect(parseCommunityRoute("/")).toEqual({ page: "home" });
    expect(parseCommunityRoute("/games/game%201")).toEqual({ page: "game", gameId: "game 1" });
    expect(parseCommunityRoute("/games/game-1/")).toEqual({ page: "game", gameId: "game-1" });
    expect(parseCommunityRoute("/games")).toEqual({ page: "not-found" });
    expect(parseCommunityRoute("/games/%")).toEqual({ page: "not-found" });
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

  it("keeps related games outside the fixed detail content", () => {
    const reserved = new Set<string>();
    for (let row = 1; row <= 5; row += 1) {
      for (let column = 1; column <= 7; column += 1) reserved.add(`${column}:${row}`);
    }
    for (let row = 6; row <= 8; row += 1) {
      for (let column = 1; column <= 3; column += 1) reserved.add(`${column}:${row}`);
    }
    for (let row = 6; row <= 7; row += 1) {
      for (let column = 4; column <= 5; column += 1) reserved.add(`${column}:${row}`);
    }

    const occupied = new Set(reserved);
    const slots = getGameDetailMosaicSlots(28);
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
