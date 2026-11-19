// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityGame } from "../src/shared/contracts.js";
import type { CommunityComment } from "../src/shared/publish-v1.js";

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const mocks = vi.hoisted(() => ({
  auth: {
    state: { status: "signed-in", user: { id: "viewer", name: "Viewer" } } as { status: string; user?: { id: string; name: string } },
    requestAccessToken: vi.fn(async () => "token"),
    openSignIn: vi.fn(),
  },
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({ useAuth: () => mocks.auth }));
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  ApiError,
  getCommunityComments: mocks.list,
  addCommunityComment: mocks.add,
  deleteCommunityComment: mocks.remove,
}));
const { GameComments } = await import("../src/renderer/community-comments.js");

const game: CommunityGame = {
  id: "game",
  title: "Example",
  description: "",
  deploymentId: "deployment",
  playUrl: "https://play.example",
  publishedAt: "2026-10-01T00:00:00Z",
  author: { id: "creator", displayName: "Creator" },
  stats: { viewCount: 4, likeCount: 2, commentCount: 2 },
};
const comment = (id: string, authorId: string, body = `Comment ${id}`): CommunityComment => ({
  id, body, createdAt: "2026-11-19T00:00:00Z", author: { id: authorId, displayName: `Person ${authorId}` },
});
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.auth.state = { status: "signed-in", user: { id: "viewer", name: "Viewer" } };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function type(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Game comments", () => {
  it("shows comments as text, posts a new one first and deletes only the viewer's own", async () => {
    mocks.list.mockResolvedValue({ comments: [comment("1", "viewer", "<b>mine</b>"), comment("2", "someone")] });
    mocks.add.mockResolvedValue({ comment: comment("3", "viewer", "Fresh"), commentCount: 3 });
    mocks.remove.mockResolvedValue(undefined);
    const onCountChange = vi.fn();
    await act(async () => root.render(<GameComments game={game} onCountChange={onCountChange} />));
    expect(mocks.list).toHaveBeenCalledWith("game", undefined);
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>mine</b>");
    expect(container.querySelectorAll('[aria-label="Delete comment"]')).toHaveLength(1);

    const textarea = container.querySelector("textarea")!;
    await act(async () => type(textarea, "  Fresh  "));
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })));
    expect(mocks.add).toHaveBeenCalledWith("game", "token", "Fresh");
    expect(onCountChange).toHaveBeenLastCalledWith(3);
    expect(textarea.value).toBe("");
    expect([...container.querySelectorAll(".community-comment-body")].map(item => item.textContent)).toEqual(["Fresh", "<b>mine</b>", "Comment 2"]);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete comment"]')!.click());
    expect(mocks.remove).toHaveBeenCalledWith("3", "token");
    expect(onCountChange).toHaveBeenLastCalledWith(1);
    expect(container.textContent).not.toContain("Fresh");
  });

  it("lets the game's creator delete anyone's comment and pages older ones without repeats", async () => {
    mocks.auth.state = { status: "signed-in", user: { id: "creator", name: "Creator" } };
    mocks.list
      .mockResolvedValueOnce({ comments: [comment("1", "a"), comment("2", "b")], nextCursor: "older" })
      .mockResolvedValueOnce({ comments: [comment("2", "b"), comment("3", "c")] });
    await act(async () => root.render(<GameComments game={game} onCountChange={vi.fn()} />));
    expect(container.querySelectorAll('[aria-label="Delete comment"]')).toHaveLength(2);
    const more = [...container.querySelectorAll("button")].find(button => button.textContent === "Show older comments")!;
    await act(async () => more.click());
    expect(mocks.list).toHaveBeenLastCalledWith("game", "older");
    expect([...container.querySelectorAll(".community-comment-body")].map(item => item.textContent)).toEqual(["Comment 1", "Comment 2", "Comment 3"]);
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Show older comments")).toBe(false);
  });

  it("asks a signed-out viewer to sign in, and shows nothing where the Cloud has no comments for the game", async () => {
    mocks.auth.state = { status: "signed-out" };
    mocks.list.mockResolvedValue({ comments: [] });
    await act(async () => root.render(<GameComments game={game} onCountChange={vi.fn()} />));
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("No comments yet.");
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Sign in to comment")!.click());
    expect(mocks.auth.openSignIn).toHaveBeenCalled();

    // An unlisted game, or a Cloud from before comments, which answers 404 for the route.
    mocks.list.mockRejectedValue(new ApiError("Not found", 404));
    await act(async () => root.render(<GameComments game={{ ...game, id: "hidden" }} onCountChange={vi.fn()} />));
    expect(container.querySelector(".community-comments")).toBeNull();
  });

  it("explains a refused comment when the account comments too quickly", async () => {
    mocks.list.mockResolvedValue({ comments: [] });
    mocks.add.mockRejectedValue(new ApiError("Too many comments", 429));
    await act(async () => root.render(<GameComments game={game} onCountChange={vi.fn()} />));
    const textarea = container.querySelector("textarea")!;
    await act(async () => type(textarea, "Again"));
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("You're commenting too quickly. Please try again in a minute.");
    expect(textarea.value).toBe("Again");
  });
});
