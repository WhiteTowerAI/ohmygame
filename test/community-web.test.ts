import { describe, expect, it, vi } from "vitest";
import { listCommunityGames } from "../src/community-web/api.js";

describe("Community Web API", () => {
  it("loads listed games", async () => {
    const first = game("first");
    const second = game("second");
    const fetcher = vi.fn(async () => Response.json([first, second]));

    await expect(listCommunityGames(fetcher)).resolves.toEqual([first, second]);
    expect(fetcher).toHaveBeenCalledWith("/v1/community/games", expect.anything());
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
