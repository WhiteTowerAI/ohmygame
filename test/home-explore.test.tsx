// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ExampleSummary } from "../src/shared/examples.js";

const examples: ExampleSummary[] = [
  ...["circuit", "tidal", "ember", "wetland"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
  { id: "last-bus", type: "web-game", name: "Last Bus", description: "" },
  ...["garden", "harbor", "orbit", "meadow"].map((id) => ({ id, type: "web-game" as const, name: id, description: "" })),
];

vi.doMock(path.resolve("src/renderer/runtime-connection.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/runtime-connection.js")>()),
  useReadyRuntimeGeneration: () => 1,
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  listProjects: async () => projects,
  listProjectTypes: () => listTypes(),
  listPluginStarters: async () => ({ plugins: [], commands: [] }),
  listProjectTemplates: async () => [],
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
const listTypes = vi.fn(async () => projectTypes);
const createProject = vi.fn(async (_input: unknown): Promise<typeof created> => created);
vi.doMock(path.resolve("src/renderer/page-frame.tsx"), () => ({
  PageFrame: ({ children, inert }: { children: React.ReactNode; inert?: boolean }) => <div className="page-frame" inert={inert}>{children}</div>,
}));
// Stands in for the prompt box: sending hands its message, with the dialog's type, to the dialog.
vi.doMock(path.resolve("src/renderer/project-prompt-creator.tsx"), () => ({
  ProjectPromptCreator: ({ onSubmit, typePending, type, placeholder }: { onSubmit: (message: unknown) => void; typePending?: boolean; type?: string; placeholder: string }) => (<>
    <p className="prompt-stand-in" data-type={type}>{placeholder}</p>
    <button type="button" disabled={typePending} onClick={() => onSubmit({ prompt: "Make a maze", mentions: [], attachments: [], mode: "normal", type })}>Send prompt</button>
  </>),
}));

const { useLeaveGuard } = await import("../src/renderer/app-navigation.js");
const { Home } = await import("../src/renderer/home.js");
const { NewGameHost, openNewGame } = await import("../src/renderer/new-game.js");
const { PLUGIN_TYPE_IMAGE, TYPE_IMAGES } = await import("../src/renderer/project-type-images.js");
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
  projects = [];
  projectTypes = [];
  listTypes.mockReset();
  localStorage.clear();
});

/** Home with the app's new game dialog, as App mounts them. */
function Guard({ save }: { save: () => Promise<void> }) {
  useLeaveGuard(save, (error) => { throw error; });
  return null;
}

async function renderHome(props: { save?: () => Promise<void>; onCreate?: () => void; onOpen?: (id: string) => void } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<>
    {props.save && <Guard save={props.save} />}
    <Home onNavigate={() => {}} onOpen={props.onOpen ?? (() => {})} />
    <NewGameHost onCreate={props.onCreate ?? (() => {})} onOpen={props.onOpen ?? (() => {})} />
  </>));
}

it("shows two rows of examples in Explore, above Asset templates, so an example past the first row is there too", async () => {
  await renderHome();

  const shown = [...container!.querySelectorAll(".home-explore-card")].map((card) => card.textContent);
  // Four columns by default: eight cards, including Last Bus in fifth place.
  expect(shown).toHaveLength(8);
  expect(shown.some((text) => text?.includes("Last Bus"))).toBe(true);
  expect(shown.some((text) => text?.includes("meadow"))).toBe(false);
  // Asset presets live on the canvas, so Home has no template section.
  expect(container!.querySelector(".home-templates")).toBeNull();
  // Example cards are titled only; the type isn't repeated under every one.
  expect(container!.querySelector(".home-explore-card small")).toBeNull();
});

it("keeps Last Bus visible when the fifth example starts a partial row", async () => {
  const all = examples.splice(5);
  try {
    await renderHome();
    const titles = [...container!.querySelectorAll(".home-explore-card strong")].map((title) => title.textContent);
    expect(titles).toEqual(examples.map((example) => example.name));
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

it.each(["acme/tiles:map", "web-game", "interactive-story"])("recovers failed plugin choices with %s selected", async (remembered) => {
  const plugin = { id: "acme/tiles:map", title: "Tile Map", plugin: { id: "acme/tiles", version: "1.0.0" } };
  projectTypes = [plugin, { id: "ohmygame/godot:godot-game", title: "Duplicate Godot", plugin: { id: "ohmygame/godot", version: "1.0.0" } }];
  localStorage.setItem("ohmygame.home.projectType", remembered);
  await renderHome();
  listTypes.mockRejectedValueOnce(new Error("offline"));
  await act(async () => openNewGame());
  const dialog = () => document.querySelector<HTMLElement>(".new-game-dialog")!;
  const button = (text: string) => [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn't load plugins");
  expect(button("Send prompt").disabled).toBe(remembered === plugin.id);
  await act(async () => button("Retry").click());
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  expect(button("Send prompt").disabled).toBe(false);
  expect([...dialog().querySelectorAll('[role="radio"]')].map((item) => item.textContent)).toEqual(["Web Game", "Godot", "General Game", "Asset Canvas", "Tile Map"]);
  expect(dialog().querySelector('[aria-checked="true"]')?.textContent).toBe(remembered === plugin.id ? "Tile Map" : "Web Game");
  await act(async () => button("Asset Canvas").click());
  await act(async () => dialog().querySelector<HTMLButtonElement>(".ui-dialog-close")!.click());
  await act(async () => openNewGame());
  expect(dialog().querySelector('[aria-checked="true"]')?.textContent).toBe("Asset Canvas");
});

it("lets the user replace an unavailable type before creating a project", async () => {
  await renderHome();
  await act(async () => openNewGame({ type: "acme/removed:game" }));
  const dialog = document.querySelector<HTMLElement>(".new-game-dialog")!;
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Choose another type");
  const blank = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Blank project")!;
  expect(blank.disabled).toBe(true);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
  expect(blank.disabled).toBe(false);
  expect(dialog.querySelector('[role="alert"]')).toBeNull();
});

it("keeps the plugin type chosen on Home when starting a blank project", async () => {
  projectTypes = [{ id: "acme/plain:game", title: "Plain", plugin: { id: "acme/plain", version: "1.0.0" } }];
  await renderHome();
  const card = [...container!.querySelectorAll<HTMLButtonElement>(".new-game-card")].find((item) => item.textContent?.includes("Plain"));
  await act(async () => card!.click());
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  await act(async () => button("Blank project").click());
  await act(async () => button("Create").click());
  expect(createProject).toHaveBeenCalledWith({ projectType: "acme/plain:game" });
});

it("opens the new game dialog on a type card, keeps it while switching types, and creates the project from the prompt", async () => {
  const onCreate = vi.fn();
  const save = vi.fn(async () => {}).mockRejectedValueOnce(new Error("Canvas save conflict"));
  createProject.mockClear();
  await renderHome({ onCreate, save });
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
  const dialog = () => document.querySelector<HTMLElement>(".new-game-dialog");

  // First run: no Continue, the type cards lead under the big heading, which
  // holds the section's actions, and there is no prompt box on the page.
  expect(container!.querySelector(".home-first h1")?.textContent).toBe("What game do you want to make?");
  expect(container!.querySelector(".home-continue")).toBeNull();
  expect(container!.querySelector(".home-new .home-section-head")).toBeNull();
  expect(container!.querySelector(".prompt-stand-in")).toBeNull();
  const actions = [...container!.querySelectorAll<HTMLButtonElement>(".home-first button")].map((item) => item.textContent);
  expect(actions).toEqual(["", ""]);
  expect(container!.querySelector(".home-first button[aria-label='New project']")).not.toBeNull();
  // The grid holds only real types.
  const cards = [...container!.querySelectorAll<HTMLButtonElement>(".new-game-card")];
  expect(cards.map((card) => card.querySelector(".new-game-card-name")?.textContent)).toEqual(["Web Game", "Godot", "General Game", "Asset Canvas"]);

  await act(async () => cards[1]!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Godot");
  expect(dialog()?.querySelector(".prompt-stand-in")?.getAttribute("data-type")).toBe("godot-game");
  // The type switcher changes the type in place.
  await act(async () => dialog()!.querySelector<HTMLButtonElement>(".new-game-type")!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("Web Game");
  expect(dialog()?.querySelector(".prompt-stand-in")?.textContent).toContain("Describe your web game");

  // The prompt names the project, so there is nothing to fill in.
  expect(save).not.toHaveBeenCalled();
  await act(async () => button("Send prompt").click());
  expect(document.querySelector(".new-project-error")?.textContent).toContain("Canvas save conflict");
  expect(createProject).not.toHaveBeenCalled();
  expect(onCreate).not.toHaveBeenCalled();
  await act(async () => button("Create and start").click());
  expect(createProject).toHaveBeenCalledWith({ type: "web-game" });
  expect(onCreate).toHaveBeenCalledWith(created, "first", "Make a maze", [], [], "normal", []);
  expect(dialog()).toBeNull();

  // + opens it on General Game; Blank project opens the project dialog instead.
  await act(async () => container!.querySelector<HTMLButtonElement>(".home-first button[aria-label='New project']")!.click());
  expect(dialog()?.querySelector(".ui-dialog-title")?.textContent).toBe("General Game");
  await act(async () => button("Blank project").click());
  expect(button("Create")).toBeDefined();
  // Choose project needs the desktop folder picker.
  expect(button("Choose project")).toBeUndefined();
});

it("shows Continue to returning people as one row of cards under New project", async () => {
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
  // Starting comes first; the latest projects follow, always open.
  expect([...container!.querySelectorAll(".home-section")].map((item) => item.classList[1])).toEqual(["home-new", "home-continue", "home-explore"]);
  expect(section()!.querySelector(".home-section-head [aria-expanded]")).toBeNull();
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
