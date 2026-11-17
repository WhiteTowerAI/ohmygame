// @vitest-environment happy-dom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("resolves links relative to the Markdown file's folder without leaving the project", () => {
    expect(workspaceLinkPath("api.md", "/tmp/game", "docs")).toBe("docs/api.md");
    expect(workspaceLinkPath("../README.md", "/tmp/game", "docs/guide")).toBe("docs/README.md");
    expect(workspaceLinkPath("../../src/app.ts", "/tmp/game", "docs/guide")).toBe("src/app.ts");
    expect(workspaceLinkPath("../../secret.txt", "/tmp/game", "docs")).toBeUndefined();
    expect(workspaceLinkPath("/tmp/game/src/app.ts", "/tmp/game", "docs")).toBe("src/app.ts");
    expect(workspaceLinkPath("logo.png", undefined, "docs/img")).toBe("docs/img/logo.png");
    expect(workspaceLinkPath("docs/../README.md", undefined, "")).toBe("README.md");
    expect(workspaceLinkPath("../secret.txt", undefined, "")).toBeUndefined();
    expect(workspaceLinkPath("%2e%2e/%2e%2e/secret.txt", undefined, "docs")).toBeUndefined();
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

describe("opening chat links in Browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers the action only for HTTP(S) links with a Browser callback", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const text = [
      "[HTTPS](https://example.com/docs)",
      "[HTTP](http://localhost:4321/)",
      "[Email](mailto:example@example.com)",
      "[File](src/main.ts)",
      `[Long](https://example.com/${"x".repeat(4_000)})`,
    ].join(" ");
    const props = { text, onOpenWorkspaceFile: vi.fn() };
    const open = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(MarkdownContent, { ...props, onOpenInBrowser: open })));
      const actions = container.querySelectorAll<HTMLButtonElement>('button[aria-label="Open in Browser panel"]');
      expect(actions).toHaveLength(2);
      expect(actions[0]?.previousElementSibling?.textContent).toBe("HTTPS");
      expect(actions[0]?.previousElementSibling?.getAttribute("target")).toBe("_blank");
      expect(actions[1]?.previousElementSibling?.textContent).toBe("HTTP");
      actions[0]!.focus();
      expect(document.activeElement).toBe(actions[0]);
      await act(async () => actions[0]!.click());
      expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
      await act(async () => root.render(createElement(MarkdownContent, props)));
      expect(container.querySelector('button[aria-label="Open in Browser panel"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("code block copy button", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the result of the latest copy attempt", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Document is not focused."))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownContent, { text: "```\nnpm test\n```" })));

    const button = container.querySelector("button")!;
    try {
      await act(async () => button.click());
      expect(button.textContent).toBe("Copied");
      await act(async () => button.click());
      expect(button.textContent).toBe("Could not copy");
      await act(async () => button.click());
      expect(button.textContent).toBe("Copied");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
