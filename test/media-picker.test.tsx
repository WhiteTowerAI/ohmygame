// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceFile } from "../src/shared/contracts.js";

const api = vi.hoisted(() => ({ listProjects: vi.fn(), listWorkspaceFiles: vi.fn() }));
vi.mock("../src/renderer/api.js", () => api);
const { MediaPicker } = await import("../src/renderer/media-picker.js");

const projects = [
  { id: "forest", name: "Forest", type: "web-game", updatedAt: "2026-10-02T00:00:00Z" },
  { id: "desert", name: "Desert", type: "web-game", updatedAt: "2026-10-01T00:00:00Z" },
];
const files: Record<string, WorkspaceFile[]> = {
  forest: [
    { path: "old.png", size: 1, mediaType: "image", modifiedAt: "2026-10-01T00:00:00Z" },
    { path: "hero.png", size: 1, mediaType: "image", modifiedAt: "2026-10-03T00:00:00Z" },
    { path: ".ohmygame/media/references/sketch.png", size: 1, mediaType: "image", purpose: "reference" },
    { path: "theme.mp3", size: 1, mediaType: "audio" },
    { path: "index.html", size: 1 },
  ],
  desert: [{ path: "villain.png", size: 1, mediaType: "image" }],
};

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", undefined);
  api.listProjects.mockResolvedValue(projects);
  api.listWorkspaceFiles.mockImplementation(async (projectId: string) => files[projectId] ?? []);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const items = () => [...document.querySelectorAll<HTMLButtonElement>(".canvas-video-picker-list > button")].map((button) => button.title);

it("opens on the project's media, newest first, without the references sent in conversations", async () => {
  await act(async () => root.render(<MediaPicker title="From assets" projectId="forest" onClose={vi.fn()} onSelect={vi.fn()} />));
  expect(items()).toEqual(["hero.png", "old.png", "theme.mp3"]);
  await act(async () => root.render(<MediaPicker title="From assets" projectId="forest" includeReferences accept={(file) => file.mediaType === "image"} onClose={vi.fn()} onSelect={vi.fn()} />));
  expect(items()).toEqual(["hero.png", "old.png", "sketch.png"]);
});

it("picks from another project", async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<MediaPicker title="From assets" projectId="forest" onClose={vi.fn()} onSelect={onSelect} />));
  const select = document.querySelector<HTMLButtonElement>("[role=combobox]")!;
  expect(select.textContent).toContain("Forest (this project)");
  await act(async () => select.click());
  const desert = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((option) => option.textContent === "Desert")!;
  await act(async () => desert.click());
  expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith("desert");
  expect(items()).toEqual(["villain.png"]);
  await act(async () => document.querySelector<HTMLButtonElement>(".canvas-video-picker-list > button")!.click());
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ projectId: "desert", path: "villain.png", contentType: "image/png" }));
});

it("says when there is nothing to pick", async () => {
  api.listProjects.mockResolvedValue([projects[0]]);
  await act(async () => root.render(<MediaPicker title="From assets" projectId="forest" accept={() => false} onClose={vi.fn()} onSelect={vi.fn()} />));
  expect(document.querySelector("[role=combobox]")).toBeNull();
  expect(document.querySelector(".canvas-video-picker-list > p")?.textContent).toBe("No assets yet");
});
