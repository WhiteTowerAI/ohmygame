// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityGame } from "../src/shared/contracts.js";

const mocks = vi.hoisted(() => ({
  auth: {
    state: { status: "signed-in", user: { id: "viewer" } },
    requestAccessToken: vi.fn(async () => "token"),
  },
  cover: vi.fn(),
  like: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => mocks.auth,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getExploreGameCover: mocks.cover,
  setCommunityLike: mocks.like,
}));
const { GameGrid, GameTile, GameStats } =
  await import("../src/renderer/community-game-card.js");

const game: CommunityGame = {
  id: "game",
  title: "Example",
  description: "",
  deploymentId: "deployment",
  playUrl: "https://play.example",
  coverUrl: "https://play.example/cover.webp",
  publishedAt: "2026-10-01T00:00:00Z",
  author: { id: "creator", displayName: "Creator" },
  stats: { viewerCount: 4, likeCount: 2, liked: true },
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const observers: {
  notify: (entries: { isIntersecting: boolean }[]) => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
  mocks.cover.mockResolvedValue(new Blob(["cover"], { type: "image/webp" }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(
        public notify: (entries: { isIntersecting: boolean }[]) => void,
      ) {
        observers.push(this);
      }
    },
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Community covers", () => {
  it("keeps works beyond the original mosaic limit and opens the correct work after filtering", async () => {
    const games = Array.from({ length: 29 }, (_, index) => ({
      ...game,
      id: `game-${index}`,
      title: `Example ${index}`,
    }));
    const onOpen = vi.fn();
    const render = async (values: CommunityGame[]) =>
      act(async () => root.render(<GameGrid games={values} onOpen={onOpen} />));
    await render(games);
    expect(container.querySelectorAll("article")).toHaveLength(29);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Play Example 28"]')!
        .click(),
    );
    expect(onOpen).toHaveBeenLastCalledWith(games[28]);
    await render([games[28]]);
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.textContent).toContain("Example 28");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".explore-game-open")!.click(),
    );
    expect(onOpen).toHaveBeenLastCalledWith(games[28]);
  });

  it("requests only visible covers and retains them when stats change", async () => {
    const render = async (value = game) =>
      act(async () =>
        root.render(<GameTile game={value} onOpen={() => undefined} />),
      );
    await render();
    expect(observers[0].observe).toHaveBeenCalledWith(
      container.querySelector("article"),
    );
    expect(mocks.cover).not.toHaveBeenCalled();
    await act(async () => observers[0].notify([{ isIntersecting: false }]));
    expect(mocks.cover).not.toHaveBeenCalled();
    await act(async () => observers[0].notify([{ isIntersecting: true }]));
    expect(mocks.cover).toHaveBeenCalledWith("game", "deployment", undefined);
    expect(
      container.querySelector(".explore-game-cover")?.getAttribute("src"),
    ).toBe("blob:cover");
    expect(observers[0].disconnect).toHaveBeenCalled();
    await render({ ...game, stats: { viewerCount: 5, likeCount: 3 } });
    expect(mocks.cover).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:cover");
  });

  it("does not create an object URL for a cover received after unmount", async () => {
    let resolve!: (blob: Blob) => void;
    mocks.cover.mockReturnValue(
      new Promise<Blob>((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      root.render(
        <GameTile
          game={game}
          onOpen={() => undefined}
          accessToken="owner-token"
        />,
      ),
    );
    await act(async () => observers[0].notify([{ isIntersecting: true }]));
    expect(mocks.cover).toHaveBeenCalledWith(
      "game",
      "deployment",
      "owner-token",
    );
    await act(async () => root.unmount());
    await act(async () => resolve(new Blob(["cover"])));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("Community like identity", () => {
  it("discards errors from the previous account and clears the liked display on sign-out", async () => {
    let reject!: (error: Error) => void;
    mocks.like.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const onChange = vi.fn();
    const render = async () =>
      act(async () =>
        root.render(<GameStats game={game} onChange={onChange} />),
      );
    await render();
    await act(async () => container.querySelector("button")!.click());
    mocks.auth.state = { status: "signed-out", user: { id: "viewer" } };
    await render();
    expect(
      container.querySelector("button")?.getAttribute("aria-pressed"),
    ).toBe("false");
    await act(async () => reject(new Error("Old account error")));
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Old account error");
  });
});
