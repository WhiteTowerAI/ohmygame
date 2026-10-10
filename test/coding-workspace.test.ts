import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CodingWorkspace,
  PreviewView,
  playerViewport,
  AssetsView,
  normalizePreviewPath,
  workspaceFileTree,
  workspacePathAfterChange,
} from "../src/renderer/coding-workspace.js";
import { workspaceLanguage } from "../src/renderer/highlighted-code.js";
import { filterAssets } from "../src/renderer/asset-browser.js";

describe("coding workspace", () => {
  const previewProject = { id: "game", name: "Game", type: "web-game" as const, updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/game", preview: { status: "ready" as const, url: "http://127.0.0.1:43123" } };

  it("unmounts the inline game while the player is opening or running", () => {
    for (const playerOpen of [false, true]) {
      const html = renderToStaticMarkup(createElement(PreviewView, { project: previewProject, reload: 0, revision: 0, url: previewProject.preview.url, viewport: "fit", suspended: true, playerOpen, pending: !playerOpen, onPlay: () => {} }));
      expect(html).not.toContain("<iframe");
      expect(html).toContain(playerOpen ? "Return to game" : "Opening game...");
    }
  });

  it("waits for the Preview tab before creating another inline game", () => {
    const props = { project: previewProject, reload: 0, revision: 0, url: previewProject.preview.url, viewport: "fit" as const };
    expect(renderToStaticMarkup(createElement(PreviewView, { ...props, active: false }))).not.toContain("<iframe");
    expect(renderToStaticMarkup(createElement(PreviewView, { ...props, active: true }))).toContain("<iframe");
  });

  it("uses device presets and bounds the fit viewport to supported dimensions", () => {
    expect(playerViewport("mobile")).toEqual({ width: 375, height: 667 });
    expect(playerViewport("tablet")).toEqual({ width: 768, height: 1024 });
    expect(playerViewport("fit", { width: 930.4, height: 660.8 })).toEqual({ width: 930, height: 661 });
    expect(playerViewport("fit", { width: 0, height: 0 })).toEqual({ width: 1280, height: 720 });
    expect(playerViewport("fit", { width: 20000, height: 200 })).toEqual({ width: 8192, height: 240 });
  });

  it("browses project assets without file mutation menus and keeps a shared filter entry", () => {
    const html = renderToStaticMarkup(createElement(AssetsView, {
      projectId: "project", files: [{ path: "hero.png", size: 3, mediaType: "image", origin: "generated", purpose: "asset", prompt: "A long generation prompt" }],
      loading: false, revision: 0, onShowInCode: () => undefined,
    }));
    expect(html).toContain('aria-label="Filter assets"');
    expect(html).toContain("<strong>hero.png</strong>");
    expect(html).not.toContain("Asset actions");
    expect(html).not.toContain("Save to Library");
    expect(html).not.toContain("Rename");
    expect(html).not.toContain("Delete");
  });

  it("combines project source, use, media and search filters and includes references by default", () => {
    const files = [
      { path: "hero.png", size: 3, mediaType: "image" as const, origin: "generated" as const, purpose: "asset" as const },
      { path: "reference.png", size: 4, mediaType: "image" as const, origin: "uploaded" as const, purpose: "reference" as const },
      { path: "music.mp3", size: 5, mediaType: "audio" as const },
    ];
    expect(filterAssets(files, "all", "")).toEqual(files);
    expect(filterAssets(files, "image", "REF", { origin: "uploaded", purpose: "reference" })).toEqual([files[1]]);
    expect(filterAssets(files, "all", "", { origin: "workspace", purpose: "asset" })).toEqual([files[2]]);
    expect(filterAssets(files, "audio", "", { origin: "generated" })).toEqual([]);
  });

  it("keeps selection attached to renamed files/folders and clears deleted paths", () => {
    expect(workspacePathAfterChange("art/hero.png", { from: "art", to: "media" })).toBe("media/hero.png");
    expect(workspacePathAfterChange("art/hero.png", { from: "art" })).toBeUndefined();
    expect(workspacePathAfterChange("artwork/hero.png", { from: "art" })).toBe("artwork/hero.png");
    expect(workspacePathAfterChange(undefined, { to: "src/new.ts" })).toBe("src/new.ts");
    expect(workspacePathAfterChange("src/main.ts", {})).toBe("src/main.ts");
  });

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

  it("starts general projects in Code and keeps Web preview an explicit capability", () => {
    const props = {
      agentBusy: false, publishing: false, workspaceRevision: 0,
      onPublish: async () => false, onOpenPublish: () => undefined,
      onClosePublish: () => undefined, onRestart: () => undefined,
    };
    const project = { ...previewProject, type: "general" as const, preview: { status: "waiting" as const } };
    const blank = renderToStaticMarkup(createElement(CodingWorkspace, { ...props, project }));
    expect(blank).toContain('aria-label="Project settings"');
    expect(blank).not.toContain(">Preview<");
    expect(blank).not.toContain("<iframe");
    expect(blank).toContain('title="Publish" aria-label="Publish"');
    expect(blank).not.toContain('disabled="" title="Publish"');

    const runnable = renderToStaticMarkup(createElement(CodingWorkspace, { ...props, project: { ...project, webPreviewEnabled: true, preview: previewProject.preview } }));
    expect(runnable).toContain(">Preview<");
    expect(runnable).toContain(`src="${previewProject.preview.url}/"`);
    expect(runnable).toContain('aria-label="Play"');
    expect(runnable).not.toContain("Publishing requires a Web build");
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
