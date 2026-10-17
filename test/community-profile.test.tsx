// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";
import type { CommunityProfile } from "../src/shared/publish-v1.js";

const mocks = vi.hoisted(() => ({
  auth: {
    state: { status: "signed-in", user: { id: "creator" } },
    requestAccessToken: vi.fn(async () => "token"),
  },
  own: vi.fn(),
  projects: vi.fn<() => Promise<ProjectState[]>>(),
  public: vi.fn(),
  unpublish: vi.fn(),
  update: vi.fn(),
  cover: vi.fn(),
  like: vi.fn(),
  publish: vi.fn(),
  games: vi.fn(),
  detail: vi.fn(),
  view: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => mocks.auth,
  localDebug: false,
}));
vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), () => ({
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/sidebar-page.tsx"), () => ({
  SidebarPageLayout: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
  SidebarPageHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  waitForRuntime: async () => undefined,
  getMyCommunityGames: mocks.own,
  getCommunityProfile: mocks.public,
  listProjects: mocks.projects,
  getExploreGameCover: mocks.cover,
  unpublishCommunityGame: mocks.unpublish,
  updateCommunityGame: mocks.update,
  publishProject: mocks.publish,
  getProjectCover: async () => undefined,
  getProjectCoverState: async () => ({ mode: "auto" }),
  setCommunityLike: mocks.like,
  listExploreGames: mocks.games,
  getExploreGame: mocks.detail,
  recordCommunityView: mocks.view,
}));
const { CommunityProfilePage } =
  await import("../src/renderer/community-profile.js");
const { GamesPage, GamePlayer } = await import("../src/renderer/games.js");

const profile: CommunityProfile = {
  author: { id: "creator", displayName: "Creator" },
  totalLikes: 2,
  games: ["listed", "unlisted"].map((status) => ({
    id: status,
    title: status === "listed" ? "Public game" : "Hidden game",
    description: "Description",
    author: { id: "creator", displayName: "Creator" },
    listingStatus: status as "listed" | "unlisted",
    deploymentId: `deployment-${status}`,
    coverUrl: `https://play.example/${status}/cover.webp`,
    playUrl: `https://play.example/${status}`,
    publishedAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    stats: { viewerCount: 3, likeCount: 1 },
  })),
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.clearAllMocks();
  mocks.auth.state = { status: "signed-in", user: { id: "creator" } };
  mocks.own.mockResolvedValue(structuredClone(profile));
  mocks.public.mockResolvedValue({
    ...profile,
    totalLikes: 1,
    games: [profile.games[0]],
  });
  mocks.projects.mockResolvedValue([]);
  window.location.hash = "#/community/games/listed";
  mocks.cover.mockResolvedValue(undefined);
  mocks.unpublish.mockResolvedValue(undefined);
  mocks.update.mockImplementation(async (_id, _token, metadata) => metadata);
  mocks.like.mockResolvedValue({ viewerCount: 3, likeCount: 2, liked: true });
  mocks.games.mockResolvedValue(profile.games);
  mocks.detail.mockResolvedValue({
    ...profile.games[0],
    playUrl: "about:blank",
  });
  mocks.view.mockResolvedValue({ viewerCount: 3, likeCount: 1 });
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
async function render(onOpenGame = vi.fn()) {
  await act(async () =>
    root.render(
      <CommunityProfilePage
        authorId="creator"
        onNavigate={() => undefined}
        onBack={() => undefined}
        onOpenGame={onOpenGame}
      />,
    ),
  );
}
async function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  expect(button).not.toBeNull();
  await act(async () => button!.click());
}
async function sortByLikes() {
  await click("Filter games");
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "likes";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function displayedGames() {
  return [...container.querySelectorAll(".community-card-title")].map(
    (element) => element.textContent,
  );
}

async function renderPlayer(gameId = "listed") {
  await act(async () =>
    root.render(
      <GamePlayer
        gameId={gameId}
        onBack={() => undefined}
        onNavigate={() => undefined}
        onOhMyGame={() => undefined}
      />,
    ),
  );
}
async function chooseUnpublish() {
  await click("More game actions");
  const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(item.textContent).toContain("Unpublish");
  await act(async () => item.click());
}
async function submitEditor() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
const localProject: ProjectState = {
  id: "local-project",
  name: "Local project",
  type: "web-game",
  workspacePath: "/tmp/local-project",
  updatedAt: profile.games[0].publishedAt,
  preview: { status: "waiting" },
  publication: {
    gameId: "listed",
    deploymentId: "deployment-listed",
    playUrl: profile.games[0].playUrl,
    publishedAt: profile.games[0].publishedAt,
  },
};

describe("game detail management", () => {
  it("opens owner profile cards as games, without management UI or local project reads", async () => {
    const open = vi.fn();
    await render(open);
    expect(displayedGames()).toEqual(["Hidden game", "Public game"]);
    expect(container.querySelector(".community-card-actions")).toBeNull();
    expect(container.textContent).not.toContain(
      "Unpublishing stops deployment",
    );
    expect(mocks.projects).not.toHaveBeenCalled();
    await click("Play Public game");
    expect(open).toHaveBeenCalledWith("listed");
  });

  it("shows owner controls before related games, view metrics or iframe finish loading", async () => {
    mocks.games.mockReturnValue(new Promise(() => {}));
    mocks.view.mockReturnValue(new Promise(() => {}));
    await renderPlayer();
    expect(container.querySelector('[aria-label="Edit game"]')).not.toBeNull();
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(mocks.projects).not.toHaveBeenCalled();
    expect(mocks.own).not.toHaveBeenCalled();
    expect(mocks.public).not.toHaveBeenCalled();
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(mocks.games).toHaveBeenCalledWith("token", {
      limit: 10,
      excludeGameId: "listed",
    });
    await click("Edit game");
    expect(mocks.projects).toHaveBeenCalledTimes(1);
  });

  it("hides management from other users and signed-out visitors", async () => {
    mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
    await renderPlayer();
    expect(container.querySelector('[aria-label="Edit game"]')).toBeNull();
    expect(mocks.cover).toHaveBeenCalledWith(
      "listed",
      "deployment-listed",
      undefined,
    );
    expect(
      container.querySelector('[aria-label="More game actions"]'),
    ).toBeNull();
    mocks.auth.state = { status: "signed-out", user: { id: "viewer" } };
    await renderPlayer();
    expect(container.querySelector('[aria-label="Edit game"]')).toBeNull();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("edits metadata without a local project or restarting the iframe", async () => {
    mocks.projects.mockRejectedValueOnce(
      new Error("Local project read failed"),
    );
    await renderPlayer();
    const frame = container.querySelector("iframe");
    await click("Edit game");
    expect(document.activeElement).toBe(container.querySelector("input"));
    expect(container.textContent).not.toContain("Open project");
    expect(container.textContent).not.toContain("Publish update");
    mocks.update.mockResolvedValueOnce({
      title: "Saved game",
      description: "Saved description",
    });
    await submitEditor();
    expect(mocks.update).toHaveBeenCalledWith("listed", "token", {
      title: "Public game",
      description: "Description",
    });
    expect(container.querySelector("h1")?.textContent).toBe("Saved game");
    expect(
      container.querySelector(".electron-game-identity")?.textContent,
    ).toContain("Saved description");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("adds local shortcuts when delayed matching completes and reloads only a newly published deployment", async () => {
    let resolve!: (projects: ProjectState[]) => void;
    mocks.projects.mockReturnValueOnce(
      new Promise<ProjectState[]>((done) => {
        resolve = done;
      }),
    );
    await renderPlayer();
    const frame = container.querySelector("iframe");
    await click("Edit game");
    expect(container.textContent).not.toContain("Open project");
    await act(async () => resolve([localProject]));
    expect(
      container.querySelector('a[href="#/projects/local-project"]'),
    ).not.toBeNull();
    const publish = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Publish update"),
    )!;
    await act(async () => {
      const title = container.querySelector("input")!;
      const description = container.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, "  Unsaved new title  ");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(description, "  Unsaved new description  ");
      description.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => publish.click());
    expect(
      container.querySelector<HTMLInputElement>("input:not([type])")?.value,
    ).toBe("Unsaved new title");
    expect(container.querySelector("textarea")?.value).toBe(
      "Unsaved new description",
    );
    mocks.publish.mockResolvedValueOnce({
      game: {
        id: "listed",
        title: "Updated game",
        description: "Updated description",
        playUrl: "about:blank",
      },
      deployment: {
        id: "new-deployment",
        publishedAt: "2026-10-14T00:00:00Z",
        coverUrl: "https://play.example/new-cover.webp",
      },
    });
    await submitEditor();
    expect(mocks.publish).toHaveBeenCalledWith("local-project", "token", {
      title: "Unsaved new title",
      description: "Unsaved new description",
    });
    expect(container.querySelector("iframe")).not.toBe(frame);
    expect(container.querySelector("h1")?.textContent).toBe("Updated game");
    expect(mocks.cover).toHaveBeenCalledWith(
      "listed",
      "new-deployment",
      "token",
    );
    expect(container.textContent).toContain("Game published");
  });

  it("supports editing and unpublishing a legacy hidden cloud work", async () => {
    mocks.detail.mockResolvedValueOnce({
      ...profile.games[1],
      playUrl: "about:blank",
    });
    await renderPlayer("unlisted");
    expect(mocks.view).not.toHaveBeenCalled();
    expect(
      container.querySelector('button[aria-label="Like Hidden game"]'),
    ).toBeNull();
    expect(mocks.cover).toHaveBeenCalledWith(
      "unlisted",
      "deployment-unlisted",
      "token",
    );
    await click("Edit game");
    await submitEditor();
    expect(mocks.update).toHaveBeenCalledWith("unlisted", "token", {
      title: "Hidden game",
      description: "Description",
    });
    await chooseUnpublish();
    await click("Confirm unpublish");
    expect(mocks.unpublish).toHaveBeenCalledWith("unlisted", "token");
    expect(window.location.hash).toBe("#/community/creators/creator");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("retains the game when unpublishing is cancelled or fails, and restores focus", async () => {
    await renderPlayer();
    await chooseUnpublish();
    expect(
      container.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain("local project files are kept");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click("Cancel unpublish");
    expect(mocks.unpublish).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "More game actions",
    );
    mocks.unpublish.mockRejectedValueOnce(new Error("Service unavailable"));
    await chooseUnpublish();
    await click("Confirm unpublish");
    expect(container.querySelector("iframe")).not.toBeNull();
    expect(
      container.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain("Service unavailable");
  });

  it("cannot restore the player when a view request finishes after unpublish", async () => {
    let resolve!: (stats: { viewerCount: number; likeCount: number }) => void;
    mocks.view.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderPlayer();
    await chooseUnpublish();
    await click("Confirm unpublish");
    await act(async () => resolve({ viewerCount: 4, likeCount: 2 }));
    expect(container.querySelector("iframe")).toBeNull();
    expect(window.location.hash).toBe("#/community/creators/creator");
  });

  it("discards a late management completion after changing games", async () => {
    let resolve!: (value: { title: string; description: string }) => void;
    mocks.update.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await renderPlayer();
    await click("Edit game");
    await submitEditor();
    mocks.detail.mockResolvedValueOnce({
      ...profile.games[1],
      playUrl: "about:blank",
    });
    await renderPlayer("unlisted");
    await act(async () =>
      resolve({ title: "Old saved title", description: "Old description" }),
    );
    expect(container.querySelector("h1")?.textContent).toBe("Hidden game");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("discards a late unpublish error after sign-out", async () => {
    let reject!: (error: Error) => void;
    mocks.unpublish.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    await renderPlayer();
    await chooseUnpublish();
    await click("Confirm unpublish");
    mocks.auth.state = { status: "signed-out", user: { id: "creator" } };
    await renderPlayer();
    await act(async () => reject(new Error("Old account error")));
    expect(container.textContent).not.toContain("Old account error");
    expect(container.querySelector('[aria-label="Edit game"]')).toBeNull();
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

describe("creator profile", () => {
  it("discards an authenticated private load after sign-out", async () => {
    let resolve!: (value: CommunityProfile) => void;
    mocks.own.mockReturnValue(
      new Promise<CommunityProfile>((done) => {
        resolve = done;
      }),
    );
    await render();
    mocks.auth.state = { status: "signed-out", user: { id: "creator" } };
    await render();
    await act(async () => resolve(profile));
    expect(mocks.public).toHaveBeenCalledWith("creator", undefined);
    expect(container.textContent).toContain("Public game");
    expect(container.textContent).not.toContain("Hidden game");
    expect(
      container.querySelector('[aria-label="Edit Public game"]'),
    ).toBeNull();
  });

  it("updates the public profile total and sort order from a card like", async () => {
    mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
    mocks.public.mockResolvedValue({
      ...profile,
      games: [
        profile.games[0],
        {
          ...profile.games[0],
          id: "other",
          title: "Other game",
          publishedAt: "2026-10-02T00:00:00Z",
        },
      ],
    });
    await render();
    await sortByLikes();
    expect(displayedGames()).toEqual(["Other game", "Public game"]);
    await click("Like Public game");
    expect(mocks.like).toHaveBeenCalledWith("listed", "token", true);
    expect(
      container.querySelector(".community-profile-summary")?.textContent,
    ).toContain("3 likes");
    expect(displayedGames()).toEqual(["Public game", "Other game"]);
    expect(
      container
        .querySelector('[aria-label="Unlike Public game"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps a completed like when an older profile refresh returns", async () => {
    mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
    await render();
    let resolve!: (value: CommunityProfile) => void;
    mocks.public.mockReturnValueOnce(
      new Promise<CommunityProfile>((done) => {
        resolve = done;
      }),
    );
    await click("Refresh");
    await click("Like Public game");
    await act(async () =>
      resolve({ ...profile, totalLikes: 1, games: [profile.games[0]] }),
    );
    expect(
      container.querySelector(".community-profile-summary")?.textContent,
    ).toContain("2 likes");
    expect(
      container.querySelector('[aria-label="Unlike Public game"]'),
    ).not.toBeNull();
  });

  it("keeps public cards mounted while signing in to like a work", async () => {
    mocks.auth.state = { status: "signed-out", user: { id: "viewer" } };
    await render();
    mocks.auth.requestAccessToken.mockImplementationOnce(async () => {
      mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
      root.render(
        <CommunityProfilePage
          authorId="creator"
          onNavigate={() => undefined}
          onBack={() => undefined}
          onOpenGame={() => undefined}
        />,
      );
      return "token";
    });
    await click("Like Public game");
    expect(mocks.like).toHaveBeenCalledWith("listed", "token", true);
    expect(
      container.querySelector(".community-profile-summary")?.textContent,
    ).toContain("2 likes");
    expect(
      container.querySelector('[aria-label="Unlike Public game"]'),
    ).not.toBeNull();
  });
});

describe("Community card interactions", () => {
  async function renderGames() {
    await act(async () =>
      root.render(
        <GamesPage onNavigate={() => undefined} onOhMyGame={() => undefined} />,
      ),
    );
  }

  it("reorders the list when a card's like count changes", async () => {
    await renderGames();
    await sortByLikes();
    expect(displayedGames()).toEqual(["Hidden game", "Public game"]);
    await click("Like Public game");
    expect(displayedGames()).toEqual(["Public game", "Hidden game"]);
  });

  it("continues a like through sign-in and preserves it against the sign-in reload", async () => {
    mocks.auth.state = { status: "signed-out", user: { id: "viewer" } };
    await renderGames();
    let resolveLoad!: (value: CommunityProfile["games"]) => void;
    let resolveLike!: (value: {
      viewerCount: number;
      likeCount: number;
      liked: boolean;
    }) => void;
    mocks.games.mockReturnValueOnce(
      new Promise<CommunityProfile["games"]>((done) => {
        resolveLoad = done;
      }),
    );
    mocks.like.mockReturnValueOnce(
      new Promise((done) => {
        resolveLike = done;
      }),
    );
    mocks.auth.requestAccessToken.mockImplementationOnce(async () => {
      mocks.auth.state = { status: "signed-in", user: { id: "viewer" } };
      root.render(
        <GamesPage onNavigate={() => undefined} onOhMyGame={() => undefined} />,
      );
      return "token";
    });
    await click("Like Public game");
    expect(mocks.like).toHaveBeenCalledWith("listed", "token", true);
    await act(async () =>
      resolveLike({ viewerCount: 3, likeCount: 2, liked: true }),
    );
    await act(async () => resolveLoad(profile.games));
    expect(
      container
        .querySelector('[aria-label="Unlike Public game"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("keeps newer likes when a delayed view count response arrives", async () => {
    mocks.detail.mockResolvedValueOnce({
      ...profile.games[0],
      playUrl: "about:blank",
    });
    let resolve!: (value: {
      viewerCount: number;
      likeCount: number;
      liked: boolean;
    }) => void;
    mocks.view.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () =>
      root.render(
        <GamePlayer
          gameId="listed"
          onBack={() => undefined}
          onNavigate={() => undefined}
          onOhMyGame={() => undefined}
        />,
      ),
    );
    await click("Like Public game");
    await act(async () =>
      resolve({ viewerCount: 4, likeCount: 1, liked: false }),
    );
    const toolbar = container.querySelector(".electron-game-toolbar")!;
    expect(
      toolbar.querySelector('[aria-label="4 unique viewers"]'),
    ).not.toBeNull();
    expect(
      toolbar.querySelector('[aria-label="Unlike Public game"]')?.textContent,
    ).toBe("2");
  });
});
