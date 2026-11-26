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
  listProjectTypes: async () => projectTypes,
  readProjectTypeCover: async () => new Blob(["png"], { type: "image/png" }),
  readPluginIconImage: async () => { throw new Error("no icon"); },
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
let projectTypes: import("../src/renderer/api.js").AvailableProjectType[] = [];
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

const { Home } = await import("../src/renderer/home.js");
const { NewGameHost } = await import("../src/renderer/new-game.js");
const { PLUGIN_TYPE_IMAGE, TYPE_IMAGES } = await import("../src/renderer/project-type-images.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  projects = [];
  projectTypes = [];
  localStorage.clear();
});

/** Home with the app's new game dialog, as App mounts them. */
async function renderHome(props: { onCreate?: () => void; onOpen?: (id: string) => void } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<>
    <Home onNavigate={() => {}} onOpen={props.onOpen ?? (() => {})} />
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
  // Asset presets live on the canvas, so Home has no template section.
  expect(container!.querySelector(".home-templates")).toBeNull();
  // Example cards are titled only; the type isn't repeated under every one.
  expect(container!.querySelector(".home-explore-card small")).toBeNull();
});

it("leaves no example alone on a row: five examples show the first four", async () => {
  const all = examples.splice(5);
  try {
    await renderHome();
    expect(container!.querySelectorAll(".home-explore-card")).toHaveLength(4);
  } finally {
    examples.push(...all);
  }
});

it("pictures every type: the app's own, a plugin type's cover, and the plugin picture for the rest", async () => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:cover", revokeObjectURL: () => {} }));
  projectTypes = [
    { id: "acme/covers:drawn", title: "Drawn", plugin: { id: "acme/covers", version: "1.0.0", revision: "a" }, cover: true },
    { id: "acme/plain:game", title: "Plain", plugin: { id: "acme/plain", version: "1.0.0", revision: "b" } },
  ];
  await renderHome();
  await act(async () => {});
  const card = (name: string) => [...container!.querySelectorAll(".new-game-card")].find((item) => item.querySelector(".new-game-card-name")?.textContent === name)!;
  const picture = (name: string) => card(name).querySelector(".new-game-art img")?.getAttribute("src");
  expect(picture("Web Game")).toBe(TYPE_IMAGES["web-game"]);
  expect(picture("Drawn")).toBe("blob:cover");
  expect(picture("Plain")).toBe(PLUGIN_TYPE_IMAGE);
  // Each type's own small icon sits over its name; a plugin without an icon gets the plug, not a lone letter.
  expect(card("Web Game").querySelector(".new-game-card-copy > .new-game-glyph svg")).not.toBeNull();
  expect(card("Plain").querySelector(".new-game-glyph svg")).not.toBeNull();
  expect(card("Plain").querySelector(".plugin-monogram")).toBeNull();
});

it("opens the new game dialog on a type card, keeps it while switching types, and creates the project from the prompt", async () => {
  const onCreate = vi.fn();
  await renderHome({ onCreate });
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  const dialog = () => document.querySelector<HTMLElement>(".new-game-dialog");

  // First run: no Continue, the type cards lead under the big heading, which
  // holds the section's actions, and there is no prompt box on the page.
  expect(container!.querySelector(".home-first h1")?.textContent).toBe("What game do you want to make?");
  expect(container!.querySelector(".home-continue")).toBeNull();
  expect(container!.querySelector(".home-new .home-section-head")).toBeNull();
  expect(container!.querySelector(".prompt-stand-in")).toBeNull();
  const actions = [...container!.querySelectorAll<HTMLButtonElement>(".home-first button")].map((item) => item.textContent);
  expect(actions).toEqual(["", expect.stringMatching(/^Describe it/)]);
  // The grid holds only real types.
  const cards = [...container!.querySelectorAll<HTMLButtonElement>(".new-game-card")];
  expect(cards.map((card) => card.querySelector(".new-game-card-name")?.textContent)).toEqual(["Web Game", "Godot", "Interactive Story", "General Game", "Asset Canvas"]);

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
  await act(async () => [...container!.querySelectorAll<HTMLButtonElement>(".home-first button")].find((item) => item.textContent?.startsWith("Describe it"))!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("General Game");
  await act(async () => button("Blank project").click());
  expect(button("Create")).toBeDefined();
  // Choose project needs the desktop folder picker.
  expect(button("Choose project")).toBeUndefined();
});

it("shows Continue to returning people as one row of cards, and folds it to a line", async () => {
  projects = ["Storm Ruins", "Ghost Courier", "Cloud Run", "Kitchen Brawl", "Cat Cafe"].map((name, index) => ({ ...created, id: `p${index}`, name }));
  const onOpen = vi.fn();
  await renderHome({ onOpen });
  const section = () => container!.querySelector<HTMLElement>(".home-continue");
  expect(container!.querySelector(".home-first")).toBeNull();
  // Returning, New game has its own heading, with a note on more types beside Describe it.
  const head = container!.querySelector(".home-new .home-section-head")!;
  expect(head.querySelector("h2")?.textContent).toBe("New project");
  // The note only says plugins add types; it doesn't send the person to Plugins.
  const more = head.querySelector<HTMLButtonElement>('[aria-label="More types"]')!;
  await act(async () => { more.focus(); more.click(); });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Plugins can add more game types.");
  expect(window.location.hash).toBe("");
  // One row of cards, as many as the shelf fits (four here), latest first.
  expect([...section()!.querySelectorAll(".home-continue-body .project-card-name")].map((name) => name.textContent)).toEqual(["Storm Ruins", "Ghost Courier", "Cloud Run", "Kitchen Brawl"]);
  await act(async () => section()!.querySelector<HTMLButtonElement>(".project-card-open")!.click());
  expect(onOpen).toHaveBeenCalledWith("p0");

  // Folded, it is one line that still opens the latest project.
  await act(async () => section()!.querySelector<HTMLButtonElement>('[aria-label="Collapse"]')!.click());
  expect(section()?.classList.contains("is-collapsed")).toBe(true);
  expect(section()?.querySelector(".home-continue-line-name")?.textContent).toBe("Storm Ruins");
  expect(localStorage.getItem("ohmygame:home-continue")).toBe("collapsed");

  // It can only be folded, not hidden; expanding brings it back.
  expect(section()!.querySelector('[aria-label="Continue options"]')).toBeNull();
  await act(async () => section()!.querySelector<HTMLButtonElement>('[aria-label="Expand"]')!.click());
  expect(section()?.classList.contains("is-collapsed")).toBe(false);
  expect(localStorage.getItem("ohmygame:home-continue")).toBeNull();
});

it.each([
  [1, false],
  [2, true],
  [3, true],
])("gives each of %i projects a card in Continue's row", async (count, allProjects) => {
  projects = ["Storm Ruins", "Ghost Courier", "Cloud Run"].slice(0, count).map((name, index) => ({ ...created, id: `p${index}`, name }));
  const onOpen = vi.fn();
  await renderHome({ onOpen });
  const section = container!.querySelector<HTMLElement>(".home-continue")!;
  expect(section.querySelectorAll(".home-continue-body .project-card-name")).toHaveLength(count);
  // All projects shows once there is more than one.
  expect([...section.querySelectorAll("button")].some((item) => item.textContent === "All projects")).toBe(allProjects);
  await act(async () => section.querySelector<HTMLButtonElement>(".project-card-open")!.click());
  expect(onOpen).toHaveBeenCalledWith("p0");
});

