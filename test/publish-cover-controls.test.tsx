// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProjectCoverState,
  ProjectState,
} from "../src/shared/contracts.js";
const getProjectCover = vi.fn<() => Promise<Blob | undefined>>();
const getProjectCoverState = vi.fn<() => Promise<ProjectCoverState>>();
const setProjectCover = vi.fn<() => Promise<void>>();
const setProjectCoverMode = vi.fn<() => Promise<void>>();
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  getProjectCover,
  getProjectCoverState,
  setProjectCover,
  setProjectCoverMode,
  getExploreGameCover: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/image.ts"), () => ({
  imageToWebP: vi.fn(async () => new Blob(["custom"], { type: "image/webp" })),
}));
const { PublishDialog } = await import("../src/renderer/publish-dialog.js");

const project: ProjectState = {
  id: "project-1",
  name: "Game",
  type: "web-game",
  workspacePath: "/tmp/game",
  updatedAt: "2026-10-13T00:00:00.000Z",
  preview: { status: "waiting" },
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cover");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.mocked(getProjectCover).mockResolvedValue(
    new Blob(["automatic"], { type: "image/webp" }),
  );
  vi.mocked(getProjectCoverState).mockResolvedValue({ mode: "auto" });
  vi.mocked(setProjectCoverMode).mockResolvedValue(undefined);
  vi.mocked(setProjectCover).mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderDialog() {
  await act(async () =>
    root.render(
      <PublishDialog
        project={project}
        publishing={false}
        onClose={() => {}}
        onPublish={async () => true}
      />,
    ),
  );
  return container.querySelector<HTMLInputElement>('[role="switch"]')!;
}

describe("publish cover controls", () => {
  it.each(["auto", "custom"] as const)(
    "keeps the cover visible while changing from %s mode",
    async (mode) => {
      getProjectCoverState.mockResolvedValue({ mode });
      const toggle = await renderDialog();
      const preview = container.querySelector("img");
      let resolveCover!: (cover: Blob) => void;
      getProjectCover.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCover = resolve;
        }),
      );
      await act(async () => toggle.click());
      expect(toggle.disabled).toBe(true);
      expect(container.querySelector("img")).toBe(preview);
      expect(container.textContent).not.toContain("No cover selected");
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      await act(async () =>
        resolveCover(new Blob(["cover"], { type: "image/webp" })),
      );
      expect(toggle.disabled).toBe(false);
    },
  );

  it("turns automatic replacement off and on without an image upload", async () => {
    const toggle = await renderDialog();
    expect(toggle.checked).toBe(true);
    await act(async () => toggle.click());
    expect(setProjectCoverMode).toHaveBeenLastCalledWith(project.id, "custom");
    expect(toggle.checked).toBe(false);
    expect(setProjectCover).not.toHaveBeenCalled();
    expect(container.querySelector("img")).not.toBeNull();
    await act(async () => toggle.click());
    expect(setProjectCoverMode).toHaveBeenLastCalledWith(project.id, "auto");
    expect(toggle.checked).toBe(true);
    expect(container.textContent).not.toContain("Restore automatic cover");
    expect(container.textContent).not.toContain(
      "Automatic replacement is off.",
    );
  });

  it("keeps the saved switch state and reports a failed change", async () => {
    vi.mocked(getProjectCoverState).mockResolvedValue({ mode: "custom" });
    vi.mocked(setProjectCoverMode).mockRejectedValue(
      new Error("Could not save cover mode"),
    );
    const toggle = await renderDialog();
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save cover mode",
    );
  });

  it("requires applying or cancelling a selected image before toggling", async () => {
    const toggle = await renderDialog();
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["image"], "cover.png", { type: "image/png" })],
    });
    await act(async () =>
      input.dispatchEvent(new Event("change", { bubbles: true })),
    );
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toContain("Apply or cancel");
    const apply = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent === "Apply cover")!;
    await act(async () => apply.click());
    expect(setProjectCover).toHaveBeenCalledWith(project.id, expect.any(Blob));
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain("Cover applied.");
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("Cover applied.");
  });
});
