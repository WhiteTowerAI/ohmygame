// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ExampleSummary } from "../src/shared/examples.js";

const examples: ExampleSummary[] = [
  ...["circuit", "tidal", "ember", "wetland", "garden"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
  { id: "last-bus", type: "interactive-story", name: "Last Bus", description: "" },
  ...["harbor", "orbit", "meadow"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
];

vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/runtime-connection.js")>()),
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects: async () => [],
  listExamples: async () => examples,
  getExampleCover: async () => undefined,
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => ({ plugins: [], skills: [] }),
  getProjectLocation: async () => ({ location: "/tmp/projects" }),
  createProject,
  createConversation: async () => ({ id: "first" }),
}));
const created = { id: "maze", name: "Maze", type: "web-game", updatedAt: "2026-10-31T00:00:00Z", workspacePath: "/tmp/maze", preview: { status: "waiting" } };
const createProject = vi.fn(async (_input: unknown): Promise<typeof created> => created);
vi.doMock(path.resolve("src/renderer/page-frame.tsx"), () => ({
  PageFrame: ({ children, inert }: { children: React.ReactNode; inert?: boolean }) => <div className="page-frame" inert={inert}>{children}</div>,
}));
// Stands in for the prompt box: sending hands its message to Home.
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({
  ProjectPromptCreator: ({ onSubmit, starts }: { onSubmit: (message: unknown) => void; starts?: React.ReactNode }) => (<>
    <button type="button" onClick={() => onSubmit({ prompt: "Make a maze", mentions: [], attachments: [], mode: "normal" })}>Send prompt</button>
    {starts}
  </>),
}));

const { Home } = await import("../src/renderer/home.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

it("shows two rows of examples in Explore, so an example past the first row is there too", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Home onNavigate={() => {}} onCreate={async () => {}} onOpen={() => {}} />));

  const shown = [...container.querySelectorAll(".home-explore-card")].map((card) => card.textContent);
  // Four columns by default: eight cards, including Last Bus in sixth place.
  expect(shown).toHaveLength(8);
  expect(shown.some((text) => text?.includes("Last Bus"))).toBe(true);
  expect(shown.some((text) => text?.includes("meadow"))).toBe(false);
});

it("creates the project from the prompt at once, and opens the new-project dialog from Blank project", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onCreate = vi.fn();
  await act(async () => root!.render(<Home onNavigate={() => {}} onCreate={onCreate} onOpen={() => {}} />));
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;

  // The prompt names the project and picks its type, so there is nothing to fill in.
  await act(async () => button("Send prompt").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(createProject).toHaveBeenCalledWith({ type: "web-game" });
  expect(onCreate).toHaveBeenCalledWith(created, "first", "Make a maze", [], [], "normal", []);

  // While it is being made, the other ways to start wait.
  let finish!: (value: typeof created) => void;
  createProject.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => button("Send prompt").click());
  expect(button("Blank project").disabled).toBe(true);
  // The page waits too, so a click elsewhere cannot leave the new project behind.
  expect(container!.querySelector(".page-frame")!.hasAttribute("inert")).toBe(true);
  await act(async () => finish(created));
  expect(button("Blank project").disabled).toBe(false);
  expect(container!.querySelector(".page-frame")!.hasAttribute("inert")).toBe(false);

  // A failure shows the dialog with the error, so the person can try again.
  createProject.mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => button("Send prompt").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Disk full");
  expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe("Make a maze");
  await act(async () => button("Cancel").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  await act(async () => button("Blank project").click());
  expect(document.querySelector('[role="dialog"] textarea')).toBeNull();
  expect(button("Create")).toBeDefined();
  // Import folder needs the desktop folder picker.
  expect(button("Import folder")).toBeUndefined();
});
