import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CodingWorkspace,
  PreviewView,
  playerViewport,
  shownViewport,
  AssetsView,
  normalizePreviewPath,
  workspaceFileTree,
  workspacePathAfterChange,
} from "../src/renderer/coding-workspace.js";
import { publishAction } from "../src/renderer/project-frame.js";
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

  it("uses device presets and a fixed fit viewport independent of the preview panel", () => {
    expect(playerViewport("mobile")).toEqual({ width: 375, height: 667 });
    expect(playerViewport("mobile-landscape")).toEqual({ width: 667, height: 375 });
    expect(playerViewport("tablet")).toEqual({ width: 768, height: 1024 });
    expect(playerViewport("fit")).toEqual({ width: 1280, height: 720 });
    const handheld = { id: "acme/devices:handheld", plugin: "acme/devices", title: "Handheld", width: 800, height: 480 } as const;
    expect(shownViewport(handheld.id, [handheld])).toEqual({ viewport: handheld.id, device: handheld });
    expect(playerViewport(handheld.id, handheld)).toEqual({ width: 800, height: 480 });
    // A device whose plugin is gone shows as Fit.
    expect(shownViewport(handheld.id, [])).toEqual({ viewport: "fit" });
    expect(shownViewport("tablet", [])).toEqual({ viewport: "tablet" });
    const stage = renderToStaticMarkup(createElement(PreviewView, { project: previewProject, reload: 0, revision: 0, url: previewProject.preview.url, viewport: handheld.id, device: handheld }));
    expect(stage).toContain("viewer-stage-device");
    expect(stage).toContain("--preview-device-ratio:800 / 480");
    // In a browser, a plugin's filter is drawn over the preview's frame.
    const filtered = renderToStaticMarkup(createElement(PreviewView, { project: previewProject, reload: 0, revision: 0, url: previewProject.preview.url, viewport: "fit", filter: { colorSpace: "sRGB", matrix: [[0.3, 0.6, 0.1], [0.3, 0.6, 0.1], [0.3, 0.6, 0.1]] } }));
    expect(filtered).toMatch(/style="filter:url\(#[^)]+\)"/);
    expect(filtered).toContain('color-interpolation-filters="sRGB"');
    expect(filtered).toContain('values="0.3 0.6 0.1 0 0 0.3 0.6 0.1 0 0 0.3 0.6 0.1 0 0 0 0 0 1 0"');
  });

  it("browses project assets as Library tiles with the source and use filters, without file mutation menus", () => {
    const html = renderToStaticMarkup(createElement(AssetsView, {
      projectId: "project", files: [{ path: "hero.png", size: 3, mediaType: "image", origin: "generated", purpose: "asset", prompt: "A long generation prompt" }],
      loading: false, revision: 0, onShowInCode: () => undefined,
    }));
    expect(html).toContain('aria-label="Source"');
    expect(html).toContain('aria-label="Use"');
    expect(html).toContain('<span class="ui-media-name-text">hero.png</span>');
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

  it("filters project assets by when they last changed", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const recent = { path: "recent.png", size: 1, mediaType: "image" as const, modifiedAt: "2026-11-08T12:00:00Z" };
    const old = { path: "old.png", size: 1, mediaType: "image" as const, modifiedAt: "2026-09-01T12:00:00Z" };
    expect(filterAssets([recent, old], "all", "", { period: "week" }, now)).toEqual([recent]);
    expect(filterAssets([recent, old], "all", "", { period: "all" }, now)).toEqual([recent, old]);
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
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).toContain("Preview will appear here");
    expect(html).toContain("Describe your game in the agent panel");
    expect(html).toContain('aria-label="More"');
    expect(html).toContain('aria-label="Pick an element in the game"');
    expect(html).not.toContain('aria-label="View publication"');
  });

  it("leaves Publish to the top bar after publishing", () => {
    const html = renderToStaticMarkup(createElement(CodingWorkspace, {
      project: {
        id: "project-1", name: "Published game", type: "web-game",
        updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/project-1",
        preview: { status: "waiting" },
        publication: { gameId: "game-1", deploymentId: "deployment-1", playUrl: "https://play.example/game-1", publishedAt: "2026-10-05T03:00:00.000Z" },
      },
      publishing: false, workspaceRevision: 0,
      onPublish: async () => false, onRestart: () => undefined,
      onClosePublish: () => undefined,
    }));
    expect(html).not.toContain("workspace-publish-button");
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
      publishing: false, workspaceRevision: 0,
      publishDialog: "success",
      onPublish: async () => false, onRestart: () => undefined,
      onClosePublish: () => undefined,
    }));
    expect(html.match(/role="dialog"/g)).toHaveLength(1);
    expect(html).toContain("Published successfully");
    expect(html).toContain("Published title");
    expect(html).toContain('value="https://play.example/game-1"');
    expect(html).not.toContain("<form");
  });

  it("puts Publish in the top bar for projects that can publish", () => {
    const idle = { publishing: false, agentBusy: false };
    expect(publishAction({ type: "web-game" }, idle)).toEqual({ disabled: false, label: "Publish", builtIn: true });
    expect(publishAction({ type: "general" }, idle)).toEqual({ disabled: false, label: "Publish", builtIn: true });
    expect(publishAction({ type: "web-game" }, { publishing: false, agentBusy: true })?.disabled).toBe(true);
    expect(publishAction({ type: "web-game" }, { publishing: true, agentBusy: false })).toEqual({ disabled: true, label: "Publishing", builtIn: true });
    expect(publishAction({ type: "godot-game" }, idle)).toEqual({ disabled: true, label: "Godot publishing is not available yet", builtIn: false });
    expect(publishAction({ type: "asset-canvas" }, idle)).toBeUndefined();
    // Plugins' ways to publish make the button usable where the app has none.
    expect(publishAction({ type: "asset-canvas" }, { ...idle, plugins: 1 })).toEqual({ disabled: false, label: "Publish", builtIn: false });
    expect(publishAction({ type: "godot-game" }, { ...idle, plugins: 2 })).toEqual({ disabled: false, label: "Publish", builtIn: false });
    expect(publishAction({ type: "general", pluginType: { preview: "native" } } as never, idle)?.disabled).toBe(true);
    expect(publishAction({ type: "general", pluginType: { preview: "native" } } as never, { ...idle, plugins: 1 })).toMatchObject({ disabled: false, builtIn: false });
  });

  it("opens a Godot workspace on its code and leaves publishing to the top bar", () => {
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
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).not.toContain("workspace-publish-button");
    expect(html).toContain('data-active-tab="code"');
    expect(html).not.toContain("<iframe");
  });

  it.each(["mobile", "mobile-landscape"] as const)("uses the saved route and %s preset when opening a Web Game preview", (viewport) => {
    const html = renderToStaticMarkup(
      createElement(CodingWorkspace, {
        project: {
          id: "project-1",
          name: "Mobile game",
          type: "web-game",
          updatedAt: new Date(0).toISOString(),
          workspacePath: "/tmp/project-1",
          previewPath: "/play",
          previewViewport: viewport,
          preview: { status: "ready", url: "http://127.0.0.1:43121" },
        },
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
        onClosePublish: () => undefined,
        onRestart: () => undefined,
      }),
    );

    expect(html).toContain(`viewer-stage-${viewport}`);
    expect(html).toContain('src="http://127.0.0.1:43121/play?__ohmygame_client=');
  });

  it("respects the saved General preview capability when opening the workspace directly", () => {
    const props = {
      publishing: false, workspaceRevision: 0,
      onPublish: async () => false,
      onClosePublish: () => undefined, onRestart: () => undefined,
    };
    const project = { ...previewProject, type: "general" as const, preview: { status: "waiting" as const } };
    const blank = renderToStaticMarkup(createElement(CodingWorkspace, { ...props, project }));
    // Its settings, where the web preview turns on, are in the top bar.
    expect(blank).not.toContain('aria-label="Project settings"');
    expect(blank).toContain('data-active-tab="code"');
    expect(blank).not.toContain("<iframe");

    const runnable = renderToStaticMarkup(createElement(CodingWorkspace, { ...props, project: { ...project, webPreviewEnabled: true, preview: previewProject.preview } }));
    expect(runnable).toContain('data-active-tab="preview"');
    expect(runnable).toContain(`src="${previewProject.preview.url}/?__ohmygame_client=`);
    expect(runnable).toMatch(/preview-play-button[^>]*>.*Play<\/button>/);
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
        publishing: false,
        workspaceRevision: 0,
        onPublish: async () => false,
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
