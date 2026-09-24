import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownContent, workspaceFileIconKind, workspaceLinkPath } from "../src/renderer/markdown-content.js";

describe("workspaceLinkPath", () => {
  it("resolves relative project links and removes line fragments", () => {
    expect(workspaceLinkPath("src/app.ts#L10", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("./README.md?plain=1", "/tmp/game")).toBe("README.md");
  });

  it("resolves absolute paths only when they belong to the project", () => {
    expect(workspaceLinkPath("/tmp/game/src/app.ts:12", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("file:///tmp/game/src/app.ts", "/tmp/game")).toBe("src/app.ts");
    expect(workspaceLinkPath("/tmp/other/secret.txt", "/tmp/game")).toBeUndefined();
  });

  it("leaves web URLs and traversal attempts outside workspace navigation", () => {
    expect(workspaceLinkPath("https://example.com/src/app.ts", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("../secret.txt", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("docs", "/tmp/game")).toBeUndefined();
    expect(workspaceLinkPath("example.com", "/tmp/game")).toBeUndefined();
  });
});

describe("workspace file link icons", () => {
  it("classifies common project files by extension", () => {
    expect(workspaceFileIconKind("src/game.tsx")).toBe("code");
    expect(workspaceFileIconKind("README.md")).toBe("text");
    expect(workspaceFileIconKind("assets/cover.PNG")).toBe("image");
    expect(workspaceFileIconKind("assets/intro.mp4")).toBe("video");
    expect(workspaceFileIconKind("assets/theme.ogg")).toBe("audio");
    expect(workspaceFileIconKind("assets/ship.glb")).toBe("model");
    expect(workspaceFileIconKind("game.data")).toBe("file");
  });

  it("adds an icon only to links routed to Code", () => {
    const html = renderToStaticMarkup(createElement(MarkdownContent, {
      text: "[Game](src/game.ts) [Site](https://example.com)",
      workspacePath: "/tmp/game",
      onOpenWorkspaceFile: () => undefined,
    }));

    expect(html).toContain('class="workspace-file-link"');
    expect(html).toContain('data-file-kind="code"');
    expect(html.match(/workspace-file-link/g)).toHaveLength(1);
  });
});
