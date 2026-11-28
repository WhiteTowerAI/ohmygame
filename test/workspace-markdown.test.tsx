// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/renderer/api.js";
import { AssetsView, WorkspaceCodeView, WorkspaceFileBrowser } from "../src/renderer/coding-workspace.js";

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
  vi.spyOn(api, "listLibrarySources").mockResolvedValue([]);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

  it("keeps relative and remote images mounted through unrelated renders and checks unchanged bytes on refresh", async () => {
    const text =
      "[![Logo](../assets/logo.png)](../README.md)\n\n![Remote](https://example.com/logo.png)\n\n![Blocked](../../secret.png)";
    await render("docs/guide.md", text);
    expect(api.getWorkspaceAsset).toHaveBeenCalledOnce();
    expect(api.getWorkspaceAsset).toHaveBeenCalledWith(
      "project",
      "assets/logo.png",
      expect.any(AbortSignal),
    );
    expect(
      container.querySelector<HTMLImageElement>('img[alt="Logo"]')?.src,
    ).toBe("blob:workspace-image");
    expect(
      container.querySelector<HTMLImageElement>('img[alt="Remote"]')?.src,
    ).toBe("https://example.com/logo.png");
    expect(container.querySelector('img[alt="Blocked"]')).toBeNull();
    const localImage = container.querySelector('img[alt="Logo"]');
    const remoteImage = container.querySelector('img[alt="Remote"]');
    const open = await render("docs/guide.md", text);
    await act(async () => container.querySelector<HTMLAnchorElement>(".workspace-file-link")!.click());
    expect(open).toHaveBeenCalledWith("README.md");
    expect(api.getWorkspaceAsset).toHaveBeenCalledOnce();
    const recheck = deferred<Blob>();
    vi.mocked(api.getWorkspaceAsset).mockReturnValueOnce(recheck.promise);
    await render("docs/guide.md", text, 1);
    expect(container.querySelector('img[alt="Logo"]')).toBe(localImage);
    expect(container.querySelector('img[alt="Remote"]')).toBe(remoteImage);
    await act(async () => recheck.resolve(new Blob(["image"], { type: "image/png" })));
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("retains the current image until a replacement decodes, ignores late reads, and clears a deleted image", async () => {
    const text = "![Logo](../assets/logo.png)";
    const stale = deferred<Blob>();
    const decoded = deferred<void>();
    const decode = vi.spyOn(Image.prototype, "decode").mockReturnValue(decoded.promise);
    vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:workspace-image").mockReturnValue("blob:replacement");
    await render("docs/guide.md", text);
    const initial = container.querySelector("img")!;
    const asset = vi.mocked(api.getWorkspaceAsset);
    asset.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(new Blob(["replacement"], { type: "image/png" }));
    await render("docs/guide.md", text, 1);
    const staleSignal = asset.mock.calls[1]![2];
    await render("docs/guide.md", text, 2);
    expect(staleSignal?.aborted).toBe(true);
    expect(decode).toHaveBeenCalledOnce();
    expect(container.querySelector("img")).toBe(initial);
    expect(initial.getAttribute("src")).toBe("blob:workspace-image");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await act(async () => decoded.resolve());
    expect(container.querySelector("img")).toBe(initial);
    expect(initial.getAttribute("src")).toBe("blob:replacement");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:workspace-image");
    await act(async () => stale.resolve(new Blob(["stale"], { type: "image/png" })));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(2);
    asset.mockRejectedValueOnce(new api.ApiError("File not found", 404));
    await render("docs/guide.md", text, 3);
    expect(container.querySelector("img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:replacement");
  });

  it("rechecks the open Markdown image when Refresh files is selected", async () => {
    const path = "guide.md";
    const content = "![Logo](logo.png)";
    const file = { path, size: content.length };
    const files = vi.spyOn(api, "listWorkspaceFiles").mockResolvedValue([file]);
    vi.spyOn(api, "getWorkspaceFile").mockResolvedValue({ ...file, content, binary: false });
    await act(async () => root.render(<WorkspaceCodeView projectId="project" revision={0} openFileRequest={{ path, id: 1 }} />));
    const image = container.querySelector('img[alt="Logo"]');
    expect(image?.getAttribute("src")).toBe("blob:workspace-image");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Refresh files"]')!.click());
    expect(files).toHaveBeenCalledTimes(2);
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector('img[alt="Logo"]')).toBe(image);
  });

  it("searches a plugin's source in Assets and adds a result to the project", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const source = { id: "acme/shapes:shapes", plugin: "acme/shapes", pluginName: "Shapes", title: "Shapes", media: ["image" as const], embedHosts: [] };
    vi.spyOn(api, "listLibrarySources").mockResolvedValue([source]);
    const search = vi.spyOn(api, "searchLibrarySource").mockResolvedValue({ items: [{ id: "circle", name: "circle.png", mediaType: "image", author: "Acme", license: "CC0" }] });
    const add = vi.spyOn(api, "addSourceItemToProject").mockResolvedValue({ path: ".ohmygame/media/imported/circle.png", name: "circle.png" });
    const logo = { path: "logo.png", mediaType: "image" as const, size: 4 };
    const added = { path: ".ohmygame/media/imported/circle.png", mediaType: "image" as const, size: 4 };
    const draw = (files: typeof logo[]) => act(async () => root.render(
      <AssetsView projectId="project" files={files} revision={0} loading={false} onShowInCode={() => {}} />,
    ));
    await draw([logo]);
    const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) => button.textContent === name)!;
    expect(tab("This project").getAttribute("aria-selected")).toBe("true");
    await act(async () => tab("Shapes").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(search).toHaveBeenCalledWith({ source: source.id, query: "", media: "image" });
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="circle.png"], .library-tiles button')!.click());
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
    await act(async () => button("Add to project")!.click());
    expect(add).toHaveBeenCalledWith("project", source.id, expect.objectContaining({ id: "circle", author: "Acme", license: "CC0" }));
    // Once added, it opens among the project's own media.
    await draw([logo, added]);
    await act(async () => button("Show in project")!.click());
    expect(tab("This project").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("circle.png");
  });

  it("refreshes Assets thumbnails by their own file metadata", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const asset = { path: "logo.png", mediaType: "image" as const, size: 4, modifiedAt: "2026-11-22T00:00:00Z" };
    const draw = (revision: number, file = asset) => act(async () => root.render(
      <AssetsView projectId="project" files={[file]} revision={revision} loading={false} onShowInCode={() => {}} />,
    ));
    await draw(0);
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    await draw(1, { ...asset });
    expect(container.querySelector("img")).toBe(image);
    expect(api.getWorkspaceAsset).toHaveBeenCalledOnce();
    await draw(2, { ...asset, modifiedAt: "2026-11-22T00:00:01Z" });
    expect(api.getWorkspaceAsset).toHaveBeenCalledTimes(2);
    expect(container.querySelector("img")).toBe(image);
  });
});
