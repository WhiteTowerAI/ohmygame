// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/renderer/api.js";
import { WorkspaceFileBrowser } from "../src/renderer/coding-workspace.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(api, "getWorkspaceGitChanges").mockResolvedValue({
    available: false,
    changes: [],
  });
  vi.spyOn(api, "getWorkspaceAsset").mockResolvedValue(
    new Blob(["image"], { type: "image/png" }),
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:workspace-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(path: string, content: string, revision = 0) {
  const onSelect = vi.fn();
  await act(async () =>
    root.render(
      <WorkspaceFileBrowser
        projectId="project"
        files={[]}
        selectedPath={path}
        selectedFile={{ path, content, size: content.length, binary: false }}
        loading={false}
        onSelect={onSelect}
        revision={revision}
      />,
    ),
  );
  return onSelect;
}

describe("workspace Markdown preview", () => {
  it.each(["docs/guide.md", "docs/guide.MARKDOWN"])(
    "renders %s and navigates relative file links",
    async (path) => {
      const onSelect = await render(
        path,
        "# Guide\n\n[Home](../README.md)\n\n```ts\nconst game = 1;\n```",
      );
      expect(container.querySelector("h1")?.textContent).toBe("Guide");
      expect(container.querySelector("pre")?.textContent).toContain(
        "const game = 1;",
      );
      await act(async () =>
        container
          .querySelector<HTMLAnchorElement>(".workspace-file-link")!
          .click(),
      );
      expect(onSelect).toHaveBeenCalledWith("README.md");
    },
  );

  it("loads relative images through workspace assets and refreshes them after file changes", async () => {
    const text =
      "![Logo](../assets/logo.png)\n\n![Remote](https://example.com/logo.png)\n\n![Blocked](../../secret.png)";
    await render("docs/guide.md", text);
    expect(api.getWorkspaceAsset).toHaveBeenCalledOnce();
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project",
      "assets/logo.png",
    );
    expect(
      container.querySelector<HTMLImageElement>('img[alt="Logo"]')?.src,
    ).toBe("blob:workspace-image");
    expect(
      container.querySelector<HTMLImageElement>('img[alt="Remote"]')?.src,
    ).toBe("https://example.com/logo.png");
    expect(container.querySelector('img[alt="Blocked"]')).toBeNull();
    await render("docs/guide.md", text, 1);
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:workspace-image");
  });
});
