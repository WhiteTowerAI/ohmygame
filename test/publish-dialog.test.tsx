import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectState, PublicationState } from "../src/shared/contracts.js";
import { PublicationDetails, PublishContentsReport, PublishDialog } from "../src/renderer/publish-dialog.js";

const publication: PublicationState = {
  gameId: "game-1",
  deploymentId: "deployment-1",
  playUrl: "https://play.example/game-1",
  title: "Published title",
  description: "A game",
  publishedAt: "2026-10-05T03:00:00.000Z",
};
const project: ProjectState = {
  id: "project-1", name: "Draft title", type: "web-game",
  workspacePath: "/tmp/project-1", updatedAt: publication.publishedAt,
  preview: { status: "waiting" },
};

describe("what publishes", () => {
  const contents = {
    source: "files" as const, bytes: 3 * 1024 * 1024, files: 3,
    folders: [{ path: "assets/", bytes: 3 * 1024 * 1024 - 100 }, { path: "index.html", bytes: 100 }],
    largest: [{ path: "assets/imported/image-2.png", bytes: 2 * 1024 * 1024 }, { path: "assets/hero.png", bytes: 1024 * 1024 - 100 }, { path: "index.html", bytes: 100 }],
  };

  it("shows the size against the Community's limit, the largest files, and what publishing optimizes", () => {
    const html = renderToStaticMarkup(<PublishContentsReport contents={contents} />);
    expect(html).toContain("3.0 MB in 3 files");
    expect(html).toContain('role="meter"');
    expect(html).toContain('style="width:3%"');
    expect(html).toContain("assets/imported/image-2.png");
    expect(html).toContain("Largest files");
    expect(html).toContain("losslessly recompresses PNG images and strips camera data from photos");
    expect(renderToStaticMarkup(<PublishContentsReport contents={contents} story />)).toContain("re-encodes videos smaller with a little quality loss");
    expect(html).not.toContain("The Community takes games up to");
    expect(html).not.toContain("From the last build");
  });

  it("warns over the limit, names a build's age, and waits for a build it doesn't have", () => {
    const over = renderToStaticMarkup(<PublishContentsReport contents={{ ...contents, source: "build", bytes: 120 * 1024 * 1024 }} />);
    expect(over).toContain("The Community limit is 100.0 MB");
    expect(over).toContain("publish-contents-meter over");
    expect(over).toContain("From the last build");
    const pending = renderToStaticMarkup(<PublishContentsReport contents={{ ...contents, source: "pending", bytes: 0, files: 0 }} />);
    expect(pending).toContain("Publishing builds the game first");
    expect(pending).not.toContain('role="meter"');
    expect(renderToStaticMarkup(<PublishContentsReport contents={undefined} />)).toContain("Checking what publishes");
  });
});

describe("publication feedback", () => {
  it("shows success with the returned title, game link, and next actions", () => {
    const html = renderToStaticMarkup(<PublicationDetails publication={publication} name={project.name} justPublished onClose={() => undefined} onUpdate={() => undefined} />);
    expect(html).toContain("Published successfully");
    expect(html).toContain("Published title");
    expect(html).toContain('value="play.example/game-1"');
    expect(html).toContain('aria-label="Copy game link"');
    expect(html).toContain('href="#/community/games/game-1"');
    expect(html).toContain('href="https://play.example/game-1" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open game"');
    expect(html).toContain("Publish update");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain(">Done<");
    expect(html).not.toContain("Local debug publish");
  });

  it("shares the game's page, readably, once the Cloud gives it one", () => {
    const named = { ...publication, name: "zombie-run", pageUrl: "https://www.ohmygame.example/g/zombie-run" };
    const html = renderToStaticMarkup(<PublicationDetails publication={named} name={project.name} onClose={() => undefined} onUpdate={() => undefined} />);
    expect(html).toContain('value="ohmygame.example/g/zombie-run"');
    expect(html).toContain('href="https://www.ohmygame.example/g/zombie-run" target="_blank"');
    expect(html).not.toContain("play.example");
  });

  it("tells a page on the site from a bare play address", async () => {
    const { hasGamePage } = await import("../src/shared/publish-v1.js");
    expect(hasGamePage({ name: "zombie-run", pageUrl: "https://www.ohmygame.example/g/zombie-run" })).toBe(true);
    expect(hasGamePage({ name: "ybn25b", pageUrl: "https://g-1.ohmygame.example/" })).toBe(false);
    expect(hasGamePage({ pageUrl: "https://www.ohmygame.example/g/zombie-run" })).toBe(false);
  });

  it("offers no rename while the Cloud gives the game no page on the site", () => {
    const bare = { ...publication, name: "ybn25b", pageUrl: publication.playUrl };
    const html = renderToStaticMarkup(<PublicationDetails publication={bare} name={project.name} onClose={() => undefined} onUpdate={() => undefined} />);
    expect(html).toContain('value="play.example/game-1"');
    expect(html).not.toContain("Change page name");
  });

  it("identifies local snapshots when reopening an existing publication", () => {
    const html = renderToStaticMarkup(<PublishDialog project={{ ...project, publication: { ...publication, gameId: "local-project-1", playUrl: "http://127.0.0.1:43199/snapshot/index.html" } }} publishing={false} onClose={() => undefined} onPublish={async () => false} />);
    expect(html).toContain("Published game");
    expect(html).toContain(`dateTime="${publication.publishedAt}" title="Last published"`);
    expect(html).not.toContain("<p>Last published</p>");
    expect(html).toContain("Local debug publish");
    expect(html).toContain("only works on this computer");
    expect(html).toContain("until the local runtime stops or restarts");
    expect(html).not.toContain("Published successfully");
  });

  it("shows the completion result after resuming a publish following sign-in", () => {
    const html = renderToStaticMarkup(<PublishDialog project={{ ...project, publication }} justPublished publishing={false} onClose={() => undefined} onPublish={async () => false} />);
    expect(html).toContain("Game published");
    expect(html).toContain("Published successfully");
    expect(html).not.toContain("<form");
  });

  it("keeps a visible publishing state and prevents duplicate submission", () => {
    const html = renderToStaticMarkup(<PublishDialog project={project} publishing onClose={() => undefined} onPublish={async () => false} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status">Publishing...');
    expect(html).toMatch(/<button type="submit"[^>]* aria-label="Publishing\.\.\." disabled="">/);
    expect(html).toMatch(/<button [^>]*aria-label="Close"[^>]* disabled="">/);
  });
});
