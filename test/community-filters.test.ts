import { describe, expect, it } from "vitest";
import type { CommunityGame } from "../src/shared/contracts.js";
import {
  DEFAULT_COMMUNITY_FILTERS,
  filterCommunityGames,
} from "../src/renderer/community-filters.js";

const games: CommunityGame[] = [
  {
    id: "older",
    title: "Echo",
    description: "Puzzle",
    author: { id: "ada", displayName: "Ada" },
    playUrl: "https://play.example/older",
    deploymentId: "d1",
    publishedAt: "2026-10-13T00:00:00Z",
    firstListedAt: "2026-09-01T00:00:00Z",
    stats: { viewerCount: 10, likeCount: 8 },
  },
  {
    id: "newer",
    title: "Orbit",
    description: "Space",
    author: { id: "lin", displayName: "Lin" },
    playUrl: "https://play.example/newer",
    deploymentId: "d2",
    publishedAt: "2026-10-12T00:00:00Z",
    firstListedAt: "2026-10-12T00:00:00Z",
    stats: { viewerCount: 20, likeCount: 3 },
  },
];

describe("Community filters", () => {
  it("finds games by creator, title, or description without mutating the source", () => {
    expect(
      filterCommunityGames(games, {
        ...DEFAULT_COMMUNITY_FILTERS,
        search: " ADA ",
      }).map((game) => game.id),
    ).toEqual(["older"]);
    expect(
      filterCommunityGames(games, {
        ...DEFAULT_COMMUNITY_FILTERS,
        search: "space",
      }).map((game) => game.id),
    ).toEqual(["newer"]);
    expect(
      filterCommunityGames(games, {
        ...DEFAULT_COMMUNITY_FILTERS,
        search: "echo",
      }).map((game) => game.id),
    ).toEqual(["older"]);
    expect(games.map((game) => game.id)).toEqual(["older", "newer"]);
  });

  it("uses first listing for recency so a new deployment does not promote an older game", () => {
    expect(
      filterCommunityGames(games, DEFAULT_COMMUNITY_FILTERS).map(
        (game) => game.id,
      ),
    ).toEqual(["newer", "older"]);
    expect(
      filterCommunityGames(
        games,
        { ...DEFAULT_COMMUNITY_FILTERS, period: "week" },
        Date.parse("2026-10-13T00:00:00Z"),
      ).map((game) => game.id),
    ).toEqual(["newer"]);
  });

  it("sorts by real metrics and retains all works beyond the former mosaic limit", () => {
    expect(
      filterCommunityGames(games, {
        ...DEFAULT_COMMUNITY_FILTERS,
        sort: "viewers",
      })[0].id,
    ).toBe("newer");
    expect(
      filterCommunityGames(games, {
        ...DEFAULT_COMMUNITY_FILTERS,
        sort: "likes",
      })[0].id,
    ).toBe("older");
    const many = Array.from({ length: 35 }, (_, index) => ({
      ...games[0],
      id: String(index),
    }));
    expect(filterCommunityGames(many, DEFAULT_COMMUNITY_FILTERS)).toHaveLength(
      35,
    );
  });
});
