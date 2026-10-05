import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectState, PublicationState } from "../src/shared/contracts.js";
import { PublicationDetails, PublishDialog } from "../src/renderer/publish-dialog.js";

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

describe("publication feedback", () => {
  it("shows success with the returned title, game link, and next actions", () => {
    const html = renderToStaticMarkup(<PublicationDetails publication={publication} name={project.name} justPublished onClose={() => undefined} onUpdate={() => undefined} />);
    expect(html).toContain("Published successfully");
    expect(html).toContain("Published title");
    expect(html).toContain('value="https://play.example/game-1"');
    expect(html).toContain('aria-label="Copy game link"');
    expect(html).toContain('href="#/community/games/game-1"');
    expect(html).toContain('href="https://play.example/game-1" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Open game"');
    expect(html).toContain("Publish update");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain(">Done<");
    expect(html).not.toContain("Local debug publish");
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
    expect(html).toContain('type="submit" aria-label="Publishing..." disabled=""');
    expect(html).toContain('disabled="" aria-label="Close"');
  });
});
