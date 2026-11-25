// @vitest-environment happy-dom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent, markdownLinkTarget, workspaceFileIconKind, workspaceLinkPath } from "../src/renderer/markdown-content.js";

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

  it("resolves Windows drive paths only when they belong to the project", () => {
    expect(workspaceLinkPath("E:/CorC++/ohmygame/src/app.ts:12", "E:/CorC++/ohmygame")).toBe("src/app.ts");
    expect(workspaceLinkPath("E:\\CorC++\\ohmygame\\src\\app.ts", "E:\\CorC++\\ohmygame")).toBe("src/app.ts");
    expect(workspaceLinkPath("E:/other-project/src/app.ts", "E:/CorC++/ohmygame")).toBeUndefined();
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

describe("markdownLinkTarget", () => {
  it("tells project files, web and email links, headings and dead links apart", () => {
    const files = { workspacePath: "/tmp/game", files: true };
    expect(markdownLinkTarget("assets/hero.png", files)).toEqual({ kind: "file", path: "assets/hero.png" });
    expect(markdownLinkTarget("https://example.com/a", files)).toEqual({ kind: "web", url: "https://example.com/a" });
    expect(markdownLinkTarget("mailto:hi@example.com", files)).toEqual({ kind: "web", url: "mailto:hi@example.com" });
    expect(markdownLinkTarget("#notes", files)).toEqual({ kind: "anchor" });
    expect(markdownLinkTarget("../outside.png", files)).toEqual({ kind: "unresolved" });
    expect(markdownLinkTarget("/tmp/other/a.png", files)).toEqual({ kind: "unresolved" });
    expect(markdownLinkTarget("javascript:alert(1)", files)).toEqual({ kind: "unresolved" });
    expect(markdownLinkTarget(undefined, files)).toEqual({ kind: "unresolved" });
    // Where files cannot be opened, a file path is not a link.
    expect(markdownLinkTarget("assets/hero.png", { files: false })).toEqual({ kind: "unresolved" });
  });
});

describe("chat link interactions", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function render(props: Parameters<typeof MarkdownContent>[0]) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownContent, props)));
    return {
      container,
      async cleanup() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  async function rightClick(element: Element) {
    await act(async () => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    return [...document.querySelectorAll<HTMLButtonElement>(".ui-menu-item")];
  }

  it("names a web link's address on hover and offers to copy it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container, cleanup } = await render({ text: "[Docs](https://example.com/docs)", onOpenInBrowser: vi.fn() });
    try {
      const link = container.querySelector("a")!;
      expect(link.title).toBe("https://example.com/docs");

      const items = await rightClick(link);
      expect(items.map((item) => item.textContent)).toEqual(["Open in Browser panel", "Open in browser", "Copy link", "Copy link text"]);
      await act(async () => items[2]!.click());
      expect(writeText).toHaveBeenCalledWith("https://example.com/docs");
      expect(document.querySelector(".ui-menu")).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("renders a link the app cannot follow as text that still names its target", async () => {
    const { container, cleanup } = await render({ text: "[Old sheet](../outside/sheet.png)", workspacePath: "/tmp/game", onOpenWorkspaceFile: vi.fn() });
    try {
      expect(container.querySelector("a")).toBeNull();
      const text = container.querySelector(".markdown-unresolved-link")!;
      expect(text.textContent).toBe("Old sheet");
      expect(text.getAttribute("title")).toBe("Can't open this link: ../outside/sheet.png");
      expect((await rightClick(text)).map((item) => item.textContent)).toEqual(["Copy link", "Copy link text"]);
    } finally {
      await cleanup();
    }
  });

  it("opens Windows Markdown file links inside the workspace", async () => {
    const open = vi.fn();
    const { container, cleanup } = await render({
      text: [
        "[Source](E:/CorC++/ohmygame/src/app.ts:12)",
        String.raw`[Readme](<e:\CorC++\ohmygame\docs\Game Guide.md>)`,
        "[Outside](E:/CorC++/ohmygame-other/src/app.ts)",
      ].join("\n\n"),
      workspacePath: String.raw`E:\CorC++\ohmygame`,
      onOpenWorkspaceFile: open,
    });
    try {
      const links = [...container.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links.map((link) => link.textContent)).toEqual(["Source", "Readme"]);
      expect(container.querySelector(".markdown-unresolved-link")?.textContent).toBe("Outside");
      await act(async () => {
        for (const link of links) link.click();
      });
      expect(open.mock.calls).toEqual([["src/app.ts"], ["docs/Game Guide.md"]]);
    } finally {
      await cleanup();
    }
  });

  it("previews a project image on hover and offers file actions on right-click", async () => {
    vi.useFakeTimers();
    const openProjectFile = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ohMyGameDesktop", { platform: "darwin", openProjectFile });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }))));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:hero", revokeObjectURL: () => undefined }));
    const open = vi.fn();
    const { container, cleanup } = await render({ text: "[Hero sheet](assets/hero.png)", projectId: "p1", workspacePath: "/tmp/game", onOpenWorkspaceFile: open });
    try {
      const link = container.querySelector<HTMLAnchorElement>(".workspace-file-link")!;
      expect(link.title).toBe("");
      await act(async () => link.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
      expect(document.querySelector(".markdown-file-preview")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(400));
      vi.useRealTimers();
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
      const card = document.querySelector(".markdown-file-preview")!;
      expect(card.querySelector(".markdown-file-preview-path")?.textContent).toBe("assets/hero.png");
      expect(card.querySelector("img")?.getAttribute("src")).toBe("blob:hero");

      const items = await rightClick(link);
      expect(document.querySelector(".markdown-file-preview")).toBeNull();
      expect(items.map((item) => item.textContent)).toEqual(["Open", "Open in default app", "Show in Finder", "Copy relative path", "Copy full path"]);
      await act(async () => items[2]!.click());
      expect(openProjectFile).toHaveBeenCalledWith("p1", "assets/hero.png", "reveal");
      await act(async () => (await rightClick(link))[4]!.click());
      expect(writeText).toHaveBeenCalledWith("/tmp/game/assets/hero.png");
      await act(async () => link.click());
      expect(open).toHaveBeenCalledExactlyOnceWith("assets/hero.png");
    } finally {
      vi.useRealTimers();
      await cleanup();
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
