import { describe, expect, it } from "vitest";
import { normalizePreviewPath, workspaceFileTree } from "../src/renderer/coding-workspace.js";
import { workspaceLanguage } from "../src/renderer/highlighted-code.js";

describe("preview path", () => {
  it("normalizes paths relative to the preview origin", () => {
    expect(normalizePreviewPath("")).toBe("/");
    expect(normalizePreviewPath("level-editor")).toBe("/level-editor");
    expect(normalizePreviewPath(" /settings?tab=audio ")).toBe("/settings?tab=audio");
  });

  it("does not allow network-path references", () => {
    const base = new URL("http://127.0.0.1:43120/");
    const inputs = ["//example.com/path", "///example.com/path", String.raw`\\example.com\path`];

    for (const input of inputs) {
      const target = new URL(normalizePreviewPath(input), base);
      expect(target.origin).toBe(base.origin);
    }
  });
});

describe("workspace file tree", () => {
  it("groups flat workspace paths into sorted folders", () => {
    expect(workspaceFileTree([
      { path: "src/styles.css", size: 1 },
      { path: "package.json", size: 1 },
      { path: "src/components/app.tsx", size: 1 },
      { path: "src/main.ts", size: 1 },
    ])).toEqual([
      {
        id: "src",
        name: "src",
        children: [
          {
            id: "src/components",
            name: "components",
            children: [{ id: "src/components/app.tsx", name: "app.tsx", path: "src/components/app.tsx" }],
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
});

describe("workspace language", () => {
  it("maps common code extensions and leaves unknown files as plain text", () => {
    expect(workspaceLanguage("src/app.tsx")).toBe("tsx");
    expect(workspaceLanguage("styles.css")).toBe("css");
    expect(workspaceLanguage("README.md")).toBe("markdown");
    expect(workspaceLanguage("data.bin")).toBeUndefined();
  });
});
