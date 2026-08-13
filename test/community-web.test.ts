import { describe, expect, it, vi } from "vitest";
import { getCommunityGame, listCommunityGames } from "../src/community-web/api.js";
import { parseCommunityRoute } from "../src/community-web/app.js";

describe("Community Web routes", () => {
  it("parses list and shareable game paths", () => {
    expect(parseCommunityRoute("/")).toEqual({ page: "list" });
    expect(parseCommunityRoute("/games/game%201")).toEqual({ page: "game", gameId: "game 1" });
    expect(parseCommunityRoute("/games/game-1/")).toEqual({ page: "game", gameId: "game-1" });
    expect(parseCommunityRoute("/games/%")).toEqual({ page: "list" });
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

  it("loads a game detail by encoded id", async () => {
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
