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
  listProjects: async () => projects,
  listProjectTypes: async () => [],
  listExamples: async () => examples,
  getExampleCover: async () => undefined,
  waitForRuntime: async () => undefined,
  getHomeComposerCapabilities: async () => ({ plugins: [], skills: [] }),
  getProjectLocation: async () => ({ location: "/tmp/projects" }),
  createProject,
  createConversation: async () => ({ id: "first" }),
}));
const created = { id: "maze", name: "Maze", type: "web-game", updatedAt: "2026-10-31T00:00:00Z", workspacePath: "/tmp/maze", preview: { status: "waiting" } };
let projects: typeof created[] = [];
const createProject = vi.fn(async (_input: unknown): Promise<typeof created> => created);
vi.doMock(path.resolve("src/renderer/page-frame.tsx"), () => ({
  PageFrame: ({ children, inert }: { children: React.ReactNode; inert?: boolean }) => <div className="page-frame" inert={inert}>{children}</div>,
}));
// Stands in for the prompt box: sending hands its message, with the dialog's type, to the dialog.
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({
  ProjectPromptCreator: ({ onSubmit, starts, type, placeholder }: { onSubmit: (message: unknown) => void; starts?: React.ReactNode; type?: string; placeholder: string }) => (<>
    <p className="prompt-stand-in" data-type={type}>{placeholder}</p>
    <button type="button" onClick={() => onSubmit({ prompt: "Make a maze", mentions: [], attachments: [], mode: "normal", type })}>Send prompt</button>
    {starts}
  </>),
}));

const createPixelAssetTemplateProject = vi.fn(async (_category: string, _level: string) => ({ projectId: "pixel", nodeId: "start" }));
vi.doMock(path.resolve("src/renderer/asset-canvas-template-project.ts"), () => ({ createPixelAssetTemplateProject }));

const { Home } = await import("../src/renderer/home.js");
const { NewGameHost } = await import("../src/renderer/new-game.js");
const { pixelAssetTemplateCategories } = await import("../src/renderer/asset-canvas-pixel-workflows.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  projects = [];
  localStorage.clear();
});

/** Home with the app's new game dialog, as App mounts them. */
async function renderHome(props: { onCreate?: () => void; onOpen?: (id: string) => void; onOpenAssetCanvas?: () => void } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<>
    <Home onNavigate={() => {}} onOpen={props.onOpen ?? (() => {})} onOpenAssetCanvas={props.onOpenAssetCanvas ?? (() => {})} />
    <NewGameHost onCreate={props.onCreate ?? (() => {})} onOpen={props.onOpen ?? (() => {})} />
  </>));
}

it("shows two rows of examples in Explore, above Asset templates, so an example past the first row is there too", async () => {
  await renderHome();

  const shown = [...container!.querySelectorAll(".home-explore-card")].map((card) => card.textContent);
  // Four columns by default: eight cards, including Last Bus in sixth place.
  expect(shown).toHaveLength(8);
  expect(shown.some((text) => text?.includes("Last Bus"))).toBe(true);
  expect(shown.some((text) => text?.includes("meadow"))).toBe(false);
  // Asset templates come after Explore.
  const headings = [...container!.querySelectorAll(".home-section-head h2")].map((heading) => heading.textContent);
  expect(headings.indexOf("Asset templates")).toBeGreaterThan(headings.indexOf("Explore"));
  // Example cards are titled only; the type isn't repeated under every one.
  expect(container!.querySelector(".home-explore-card small")).toBeNull();
});

it("opens the new game dialog on a type card, keeps it while switching types, and creates the project from the prompt", async () => {
  const onCreate = vi.fn();
  await renderHome({ onCreate });
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  const dialog = () => document.querySelector<HTMLElement>(".new-game-dialog");

  // First run: no Continue, the type cards lead, and there is no prompt box on the page.
  expect(container!.querySelector(".home-first h1")?.textContent).toBe("What game do you want to make?");
  expect(container!.querySelector(".home-continue")).toBeNull();
  expect(container!.querySelector(".prompt-stand-in")).toBeNull();
  const cards = [...container!.querySelectorAll<HTMLButtonElement>(".new-game-card")];
  expect(cards.map((card) => card.querySelector(".new-game-card-name")?.textContent)).toEqual(["Web Game", "Godot", "Interactive Story", "General Game", "Asset Canvas", "More types"]);

  await act(async () => cards[1]!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Godot");
  expect(dialog()?.querySelector(".prompt-stand-in")?.getAttribute("data-type")).toBe("godot-game");
  // The type switcher changes the type in place.
  await act(async () => dialog()!.querySelector<HTMLButtonElement>(".new-game-type")!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Web Game");
  expect(dialog()?.querySelector(".prompt-stand-in")?.textContent).toContain("Describe your web game");

  // The prompt names the project, so there is nothing to fill in.
  await act(async () => button("Send prompt").click());
  expect(createProject).toHaveBeenCalledWith({ type: "web-game" });
  expect(onCreate).toHaveBeenCalledWith(created, "first", "Make a maze", [], [], "normal", []);
  expect(dialog()).toBeNull();

  // Describe it opens it on General Game; Blank project opens the project dialog instead.
  await act(async () => container!.querySelector<HTMLButtonElement>(".home-new .home-section-head button")!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("General Game");
  await act(async () => button("Blank project").click());
  expect(button("Create")).toBeDefined();
  // Choose project needs the desktop folder picker.
  expect(button("Choose project")).toBeUndefined();
});

it("shows Continue to returning people, folds it to a line, and leaves it off Home until Settings brings it back", async () => {
  projects = ["Storm Ruins", "Ghost Courier", "Cloud Run", "Kitchen Brawl", "Cat Cafe"].map((name, index) => ({ ...created, id: `p${index}`, name }));
  const onOpen = vi.fn();
  await renderHome({ onOpen });
  const section = () => container!.querySelector<HTMLElement>(".home-continue");
  expect(container!.querySelector(".home-first")).toBeNull();
  // The latest project leads, with the next three beside it.
  expect(section()?.querySelector(".home-continue-feature .project-card-name")?.textContent).toBe("Storm Ruins");
  expect(section()!.querySelectorAll(".home-continue-list > *")).toHaveLength(3);
  await act(async () => section()!.querySelector<HTMLButtonElement>(".home-continue-open")!.click());
  expect(onOpen).toHaveBeenCalledWith("p0");

  // Folded, it is one line that still opens the latest project.
  await act(async () => section()!.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')!.click());
  expect(section()?.classList.contains("is-collapsed")).toBe(true);
  expect(section()?.querySelector(".home-continue-line-name")?.textContent).toBe("Storm Ruins");
  expect(localStorage.getItem("ohmygame:home-continue")).toBe("collapsed");

  // Hidden from its menu, it stays off Home; Settings → General turns it back on.
  await act(async () => section()!.querySelector<HTMLButtonElement>('[aria-label="Continue options"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.startsWith("Hide on Home"))!.click());
  expect(section()).toBeNull();
  expect(localStorage.getItem("ohmygame:home-continue")).toBe("hidden");
  const { setGeneralPreference } = await import("../src/renderer/general-preferences.js");
  await act(async () => setGeneralPreference("homeContinue", "shown"));
  expect(section()?.classList.contains("is-collapsed")).toBe(false);
});

it("starts a creation template at the chosen pixel density and opens its canvas on the first node", async () => {
  const onOpenAssetCanvas = vi.fn();
  await renderHome({ onOpenAssetCanvas });

  // Every pixel category, then the effect library.
  const cards = [...container!.querySelectorAll<HTMLButtonElement>(".home-templates .home-template-card")];
  expect(cards).toHaveLength(pixelAssetTemplateCategories().length + 1);
  await act(async () => cards[0]!.click());
  const dialog = document.querySelector<HTMLElement>(".pixel-template-density-dialog")!;
  expect(dialog.querySelectorAll('input[type="radio"]')).toHaveLength(3);

  await act(async () => {
    dialog.querySelector<HTMLInputElement>('input[value="detailed"]')!.click();
    dialog.querySelector<HTMLButtonElement>(".project-create-submit")!.click();
  });
  expect(createPixelAssetTemplateProject).toHaveBeenCalledWith(pixelAssetTemplateCategories()[0]!.id, "detailed");
  expect(onOpenAssetCanvas).toHaveBeenCalledWith("pixel", "start");
  expect(document.querySelector(".pixel-template-density-dialog")).toBeNull();
});
