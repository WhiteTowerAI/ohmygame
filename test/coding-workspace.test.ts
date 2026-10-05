import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CodingWorkspace,
  normalizePreviewPath,
  workspaceFileTree,
} from "../src/renderer/coding-workspace.js";
import { workspaceLanguage } from "../src/renderer/highlighted-code.js";

describe("coding workspace", () => {
  it("shows the initial preview guidance while the workspace is empty", () => {
    const html = renderToStaticMarkup(
      createElement(CodingWorkspace, {
        project: {
          id: "project-1",
          name: "Untitled project",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          preview: { status: "waiting" },
        },
        agentBusy: false,
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onOpenPublish: () => undefined,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).toContain("Preview will appear here");
    expect(html).toContain("Describe your game in the agent panel");
    expect(html).toContain('aria-label="Project settings"');
    expect(html).not.toContain('aria-label="View publication"');
  });

  it("keeps a single Publish entry after publishing", () => {
    const html = renderToStaticMarkup(createElement(CodingWorkspace, {
      project: {
        id: "project-1", name: "Published game", type: "web-game",
        updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1",
        preview: { status: "waiting" },
        publication: { gameId: "game-1", deploymentId: "deployment-1", playUrl: "https://play.example/game-1", publishedAt: "2026-10-05T03:00:00.000Z" },
      },
      agentBusy: false, publishing: false, workspaceRevision: 0,
      onPublish: async () => false, onRestart: () => undefined,
      onOpenPublish: () => undefined, onClosePublish: () => undefined,
    }));
    expect(html.match(/aria-label="Publish"/g)).toHaveLength(1);
    expect(html).toContain("<span>Publish</span>");
    expect(html).not.toContain('aria-label="View publication"');
    expect(html).not.toContain('aria-label="Publish update"');
  });

  it("shows the resumed publish result through the workspace dialog", () => {
    const html = renderToStaticMarkup(createElement(CodingWorkspace, {
      project: {
        id: "project-1", name: "Draft title", type: "web-game",
        updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1",
        preview: { status: "waiting" },
        publication: { gameId: "game-1", deploymentId: "deployment-1", title: "Published title", playUrl: "https://play.example/game-1", publishedAt: "2026-10-05T03:00:00.000Z" },
      },
      agentBusy: false, publishing: false, workspaceRevision: 0,
      publishDialog: "success",
      onPublish: async () => false, onRestart: () => undefined,
      onOpenPublish: () => undefined, onClosePublish: () => undefined,
    }));
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html).toContain("Published successfully");
    expect(html).toContain("Published title");
    expect(html).toContain('value="https://play.example/game-1"');
    expect(html).not.toContain("<form");
  });

  it("exposes Godot workspace controls without enabling publishing", () => {
    const html = renderToStaticMarkup(
      createElement(CodingWorkspace, {
        project: {
          id: "project-1",
          name: "Godot project",
          type: "godot-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          preview: { status: "stopped" },
        },
        agentBusy: false,
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onOpenPublish: () => undefined,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain(
      '<button class="publish-button workspace-publish-button" type="button" disabled="" title="Godot publishing is not available yet"',
    );
    expect(html).toContain('aria-label="Hide workspace"');
  });

  it("uses the saved route and device preset when opening a Web Game preview", () => {
    const html = renderToStaticMarkup(
      createElement(CodingWorkspace, {
        project: {
          id: "project-1",
          name: "Mobile game",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          previewPath: "/play",
          previewViewport: "mobile",
          preview: { status: "ready", url: "http://127.0.0.1:43121" },
        },
        agentBusy: false,
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onOpenPublish: () => undefined,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).toContain("viewer-stage-mobile");
    expect(html).toContain('src="http://127.0.0.1:43121/play"');
  });

  it("keeps the preview panel mounted while the workspace is rendered", () => {
    const html = renderToStaticMarkup(
      createElement(CodingWorkspace, {
        project: {
          id: "project-1",
          name: "Persistent game",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          preview: { status: "ready", url: "http://127.0.0.1:43121" },
        },
        agentBusy: false,
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onOpenPublish: () => undefined,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).toContain('class="coding-workspace-preview-panel"');
    expect(html).toContain('class="preview-frame"');
  });
});

describe("preview path", () => {
  it("normalizes paths relative to the preview origin", () => {
    expect(normalizePreviewPath("")).toBe("/");
    expect(normalizePreviewPath("level-editor")).toBe("/level-editor");
    expect(normalizePreviewPath(" /settings?tab=audio ")).toBe(
      "/settings?tab=audio",
    );
  });

  it("does not allow network-path references", () => {
    const base = new URL("http://127.0.0.1:43120/");
    const inputs = [
      "//example.com/path",
      "///example.com/path",
      String.raw`\\example.com\path`,
    ];

    for (const input of inputs) {
      const target = new URL(normalizePreviewPath(input), base);
      expect(target.origin).toBe(base.origin);
    }
  });
});

describe("workspace file tree", () => {
  it("groups flat workspace paths into sorted folders", () => {
    expect(
      workspaceFileTree([
        { path: "src/styles.css", size: 1 },
        { path: "package.json", size: 1 },
        { path: "src/components/app.tsx", size: 1 },
        { path: "src/main.ts", size: 1 },
      ]),
    ).toEqual([
      {
        id: "src",
        name: "src",
        children: [
          {
            id: "src/components",
            name: "components",
            children: [
              {
                id: "src/components/app.tsx",
                name: "app.tsx",
                path: "src/components/app.tsx",
              },
            ],
          },
          { id: "src/main.ts", name: "main.ts", path: "src/main.ts" },
          { id: "src/styles.css", name: "styles.css", path: "src/styles.css" },
        ],
      },
      { id: "package.json", name: "package.json", path: "package.json" },
    ]);
  });

  it("returns an empty tree for an empty workspace", () => {
    expect(workspaceFileTree([])).toEqual([]);
  });

  it("keeps explicit empty directories in the workspace tree", () => {
    expect(workspaceFileTree([{ path: "assets/empty", size: 0, directory: true }])).toEqual([{
      id: "assets",
      name: "assets",
      children: [{ id: "assets/empty", name: "empty", directory: true, children: [] }],
    }]);
  });
});

describe("workspace language", () => {
  it("maps common code extensions and leaves unknown files as plain text", () => {
    expect(workspaceLanguage("src/app.tsx")).toBe("tsx");
    expect(workspaceLanguage("styles.css")).toBe("css");
    expect(workspaceLanguage("README.md")).toBe("markdown");
    expect(workspaceLanguage("data.bin")).toBeUndefined();
  });
});
