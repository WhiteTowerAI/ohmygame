// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthState } from "../src/renderer/auth.js";
import type { ProjectState } from "../src/shared/contracts.js";

const auth = vi.hoisted(() => ({
  state: { status: "signed-out" } as AuthState,
  openSignIn: vi.fn(),
}));
const project = (
  id: string,
  name: string,
  updatedAt: string,
): ProjectState => ({
  id,
  name,
  type: "web-game",
  workspacePath: `/tmp/${id}`,
  updatedAt,
  preview: { status: "stopped" },
});
const projects = [
  project("old", "Old Garden", "2026-10-01T00:00:00Z"),
  project("new", "New Rocket", "2026-10-20T00:00:00Z"),
];

vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({
  useAuth: () => auth,
}));
vi.doMock(
  path.resolve("src/renderer/runtime-connection.ts"),
  async (original) => ({
    ...(await original<
      typeof import("../src/renderer/runtime-connection.js")
    >()),
    useReadyRuntimeGeneration: () => 1,
  }),
);
const conversation = (id: string, title: string, updatedAt: string) => ({
  id,
  projectId: "old",
  title,
  createdAt: updatedAt,
  updatedAt,
  messageCount: 2,
});
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  listProjects: async () => projects,
  listConversations: async () => [
    conversation("tune", "Tune the jump", "2026-10-02T00:00:00Z"),
    conversation("start", "First level", "2026-10-01T00:00:00Z"),
  ],
  waitForRuntime: async () => undefined,
  getProjectCover: async () => undefined,
}));
const { PageFrame } = await import("../src/renderer/page-frame.js");
const { ProjectRail } = await import("../src/renderer/app-sidebar.js");
const { ProjectFrame, ProjectTop } = await import("../src/renderer/project-frame.js");
const { PanelLayout } = await import("../src/renderer/panel-layout.js");
const { publishSidebarProjects, refreshSidebarProject, setVisibleProjects } =
  await import("../src/renderer/sidebar-projects.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onNavigate = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  auth.state = { status: "signed-out" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function render(active: "home" | "community" | "settings" = "home") {
  await act(async () =>
    root.render(
      <PageFrame active={active} onNavigate={onNavigate}>
        <p>Page</p>
      </PageFrame>,
    ),
  );
}

const sidebar = () => container.querySelector<HTMLElement>(".sidebar")!;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    [
      item.textContent,
      item.getAttribute("aria-label"),
      item.title,
      item.querySelector(".ui-menu-label")?.textContent,
    ].includes(label),
  );
const menuLabels = () =>
  [...document.querySelectorAll(".ui-menu-item .ui-menu-label")].map(
    (item) => item.textContent,
  );

it("lists the sections without the studios and marks the current one", async () => {
  await render();
  const sections = () => [
    ...sidebar().querySelectorAll(":scope > .sidebar-group")[1]!.children,
  ].map((item) => item.textContent);
  expect(sections()).toEqual(["Home", "Projects", "Community", "Plugins"]);
  expect(sidebar().querySelector('[aria-current="page"]')?.textContent).toBe(
    "Home",
  );
  expect(sidebar().textContent).not.toContain("Web Game");
  button("Projects")!.click();
  expect(onNavigate).toHaveBeenCalledWith("projects");
  expect(container.querySelector(".page-sheet")?.textContent).toBe("Page");
});

const quickAccess = () =>
  [...sidebar().querySelectorAll(".sidebar-recent .sidebar-item")].map(
    (item) => item.textContent,
  );
const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    project(`p${index}`, `Project ${index}`, `2026-10-${10 + index}T00:00:00Z`));

it("seeds the projects newest first, folds them, and opens one", async () => {
  // Community has no project list of its own, so the sidebar loads one.
  await render("community");
  expect(quickAccess()).toEqual(["New Rocket", "Old Garden"]);

  // A page that reloads the list hands it over, so a rename shows at once.
  await act(async () =>
    publishSidebarProjects([{ ...projects[0]!, name: "Renamed Garden" }]),
  );
  expect(quickAccess()).toEqual(["Renamed Garden"]);
  // A project renamed from inside shows its new name too.
  await act(async () => refreshSidebarProject({ ...projects[0]!, name: "Garden" }));
  expect(quickAccess()).toEqual(["Garden"]);
  await act(async () =>
    publishSidebarProjects([{ ...projects[0]!, name: "Renamed Garden" }]),
  );

  await act(async () => button("Quick access")!.click());
  expect(quickAccess()).toEqual([]);
  expect(localStorage.getItem("ohmygame-sidebar-recent-open")).toBe("false");
  await act(async () => button("Quick access")!.click());
  button("Renamed Garden")!.click();
  expect(window.location.hash).toBe("#/projects/old");
});

describe("the project list's order and count", () => {
  beforeEach(async () => {
    await render("community");
    await act(async () => {
      publishSidebarProjects([]);
      publishSidebarProjects(numbered(3));
      setVisibleProjects(8);
    });
  });

  const rowFor = (label: string) =>
    [...sidebar().querySelectorAll<HTMLElement>("[data-project-id]")].find((row) => row.textContent === label)!;
  const dragEvent = (type: string, clientY = 0) =>
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clientY,
      dataTransfer: { setData: () => undefined, effectAllowed: "", dropEffect: "" },
    });

  it("doesn't move a project when it is edited, and puts a new one first", async () => {
    expect(quickAccess()).toEqual(["Project 2", "Project 1", "Project 0"]);
    await act(async () =>
      publishSidebarProjects(numbered(3).map((item) => (item.id === "p0" ? { ...item, updatedAt: "2026-11-01T00:00:00Z" } : item))),
    );
    expect(quickAccess()).toEqual(["Project 2", "Project 1", "Project 0"]);
    await act(async () => publishSidebarProjects([...numbered(3), project("fresh", "Fresh", "2026-09-01T00:00:00Z")]));
    expect(quickAccess()).toEqual(["Fresh", "Project 2", "Project 1", "Project 0"]);
  });

  it("shows the chosen count and remembers it", async () => {
    await act(async () => publishSidebarProjects(numbered(14)));
    expect(quickAccess()).toHaveLength(8);
    const menu = () => button("Project list options")!;
    await act(async () => menu().click());
    expect(menuLabels()).toEqual(["5 projects", "8 projects", "12 projects", "All projects"]);
    await act(async () => button("5 projects")!.click());
    expect(quickAccess()).toHaveLength(5);
    expect(JSON.parse(localStorage.getItem("ohmygame-sidebar-projects")!)).toMatchObject({ version: 1, visible: 5 });
    await act(async () => menu().click());
    await act(async () => button("All projects")!.click());
    expect(quickAccess()).toHaveLength(14);
  });

  it("reorders by dragging, marking where a project will land", async () => {
    const rows = ["Project 2", "Project 1", "Project 0"].map(rowFor);
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 40, bottom: index * 40 + 34, height: 34 }) as DOMRect;
    });
    const list = sidebar().querySelector<HTMLElement>(".sidebar-project-list")!;
    await act(async () => rows[2]!.dispatchEvent(dragEvent("dragstart")));
    expect(rows[2]!.hasAttribute("data-dragged")).toBe(true);
    await act(async () => list.dispatchEvent(dragEvent("dragover", 5)));
    expect(list.querySelector(".sidebar-drop-line")).not.toBeNull();
    await act(async () => list.dispatchEvent(dragEvent("drop", 5)));
    expect(quickAccess()).toEqual(["Project 0", "Project 2", "Project 1"]);
    expect(list.querySelector(".sidebar-drop-line")).toBeNull();
    expect(JSON.parse(localStorage.getItem("ohmygame-sidebar-projects")!).order).toEqual(["p0", "p2", "p1"]);
  });

  it("ignores a drag that leaves the list", async () => {
    const list = sidebar().querySelector<HTMLElement>(".sidebar-project-list")!;
    const row = rowFor("Project 0");
    await act(async () => row.dispatchEvent(dragEvent("dragstart")));
    await act(async () => list.dispatchEvent(dragEvent("dragover", 0)));
    await act(async () => list.dispatchEvent(Object.assign(dragEvent("dragleave"), { relatedTarget: document.body })));
    await act(async () => list.dispatchEvent(dragEvent("drop", 0)));
    expect(quickAccess()).toEqual(["Project 2", "Project 1", "Project 0"]);
  });

  it("reorders with Alt and the arrows, keeping focus on the project", async () => {
    const press = async (key: string) => act(async () =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true })));
    await act(async () => rowFor("Project 2").focus());
    await press("ArrowUp");
    expect(quickAccess()).toEqual(["Project 2", "Project 1", "Project 0"]);
    await press("ArrowDown");
    expect(quickAccess()).toEqual(["Project 1", "Project 2", "Project 0"]);
    expect(document.activeElement).toBe(rowFor("Project 2"));
    await press("ArrowDown");
    expect(quickAccess()).toEqual(["Project 1", "Project 0", "Project 2"]);
    expect(document.activeElement).toBe(rowFor("Project 2"));
  });
});

it.each([
  ["damaged", "{not json"],
  ["from a newer version", JSON.stringify({ version: 2, order: ["p1"] })],
])("leaves a saved list that is %s as it is", async (_name, saved) => {
  vi.resetModules();
  localStorage.setItem("ohmygame-sidebar-projects", saved);
  const store = await import("../src/renderer/sidebar-projects.js");
  store.publishSidebarProjects(projects);
  store.setVisibleProjects(5);
  expect(localStorage.getItem("ohmygame-sidebar-projects")).toBe(saved);
  localStorage.removeItem("ohmygame-sidebar-projects");
});

it("collapses to icons and resizes from its edge, remembering both", async () => {
  await render();
  const frame = () => container.querySelector<HTMLElement>(".page-frame")!;
  const edge = () => container.querySelector<HTMLElement>('[role="separator"]');
  expect(edge()?.getAttribute("aria-valuenow")).toBe("232");
  await act(async () =>
    edge()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    ),
  );
  expect(frame().style.getPropertyValue("--sidebar-width")).toBe("248px");
  expect(localStorage.getItem("ohmygame-sidebar-width")).toBe("248");
  await act(async () =>
    edge()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  expect(edge()?.getAttribute("aria-valuenow")).toBe("232");

  await act(async () => button("Collapse sidebar")!.click());
  expect(frame().classList.contains("is-sidebar-collapsed")).toBe(true);
  expect(edge()).toBeNull();
  expect(localStorage.getItem("ohmygame-sidebar-collapsed")).toBe("true");
  // Collapsed, an item's name shows in a tooltip beside its icon.
  const projectsItem = button("Projects")!;
  expect(projectsItem.title).toBe("");
  expect(projectsItem.getAttribute("aria-label")).toBe("Projects");
  await act(async () => projectsItem.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Projects");
  await act(async () => projectsItem.blur());
  // Another page's frame opens the same way.
  await act(async () =>
    root.render(
      <PageFrame active="community" onNavigate={onNavigate}>
        {null}
      </PageFrame>,
    ),
  );
  expect(frame().classList.contains("is-sidebar-collapsed")).toBe(true);
  await act(async () => button("Expand sidebar")!.click());
  expect(frame().classList.contains("is-sidebar-collapsed")).toBe(false);
});

it("leads the signed-out menu with sign in and keeps settings and about", async () => {
  await render();
  const account =
    sidebar().querySelector<HTMLButtonElement>(".sidebar-account")!;
  expect(account.textContent).toBe("Sign in");
  await act(async () => account.click());
  expect(menuLabels()).toEqual(["Sign in", "Settings", "About OhMyGame"]);
  await act(async () => document.querySelector<HTMLButtonElement>(".ui-menu-item")!.click());
  expect(auth.openSignIn).toHaveBeenCalledOnce();

  await act(async () => account.click());
  await act(async () => button("About OhMyGame")!.click());
  expect(window.location.hash).toBe("#/settings/about");
});

it("opens settings, account and my games from the signed-in menu", async () => {
  auth.state = {
    status: "signed-in",
    user: { id: "u", name: "Ada Lovelace", email: "ada@example.com" },
  };
  await render("settings");
  const account =
    sidebar().querySelector<HTMLButtonElement>(".sidebar-account")!;
  expect(account.textContent).toBe("ALAda Lovelace");
  expect(account.classList.contains("is-active")).toBe(true);
  await act(async () => account.click());
  expect(menuLabels()).toEqual([
    "Settings",
    "Account",
    "My games",
    "About OhMyGame",
  ]);
  await act(async () => button("Account")!.click());
  expect(window.location.hash).toBe("#/settings/account");
  await act(async () => account.click());
  await act(async () => button("My games")!.click());
  expect(window.location.hash).toBe("#/community/creators/u");
  await act(async () => account.click());
  await act(async () => button("Settings")!.click());
  expect(onNavigate).toHaveBeenCalledWith("settings");
});

it("opens the command menu from Search, which shows its shortcut", async () => {
  const opened = vi.fn();
  window.addEventListener("ohmygame:command-menu", opened);
  await render();
  expect([...button("Search")!.querySelectorAll("kbd")].map((key) => key.textContent).join(" ")).toMatch(/^(⌘ K|Ctrl K)$/);
  button("Search")!.click();
  window.removeEventListener("ohmygame:command-menu", opened);
  expect(opened).toHaveBeenCalledOnce();
  expect(onNavigate).not.toHaveBeenCalled();
});

describe("in a project", () => {
  const onLeave = vi.fn((go: () => void) => go());
  const onOpen = vi.fn();
  const onNew = vi.fn();
  const hover = async (label: string) => {
    await act(async () => {
      button(label)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
  };
  const railItem = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".rail-popover-item")].find((item) => item.querySelector("span")?.textContent === label)!;
  const popoverItems = () =>
    [...document.querySelectorAll(".rail-popover-item span")].map((item) => item.textContent);

  beforeEach(async () => {
    publishSidebarProjects(projects);
    await act(async () =>
      root.render(
        <ProjectRail projectId="new" onNavigate={onNavigate} onLeave={onLeave} conversations={{
          items: [conversation("a", "Rocket fuel", "2026-10-19T00:00:00Z"), conversation("b", "Boss fight", "2026-10-20T00:00:00Z")],
          current: "a",
          onOpen,
          onNew,
        }} />,
      ),
    );
  });

  it("keeps only the way home, the projects, search and the account", async () => {
    expect(sidebar().textContent).not.toContain("Library");
    expect(sidebar().querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("New Rocket");
    await act(async () => button("OhMyGame home")!.click());
    expect(onLeave).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("home");
    // Another project opens once this one has saved.
    await act(async () => button("Old Garden")!.click());
    expect(onLeave).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe("#/projects/old");
  });

  it("lists a project's conversations on hover, newest first", async () => {
    await hover("New Rocket");
    expect(popoverItems()).toEqual(["Boss fight", "Rocket fuel", "New conversation"]);
    expect(document.querySelector(".rail-popover-item.is-current span")?.textContent).toBe("Rocket fuel");
    await act(async () => railItem("Boss fight").click());
    expect(onOpen).toHaveBeenCalledWith("b");
    await hover("New Rocket");
    await act(async () => railItem("New conversation").click());
    expect(onNew).toHaveBeenCalledOnce();

    // Another project's conversations load on hover and open that project.
    await hover("Old Garden");
    expect(popoverItems()).toEqual(["Tune the jump", "First level"]);
    await act(async () => railItem("First level").click());
    expect(window.location.hash).toBe("#/projects/old/conversations/start");
  });

  it("opens and walks the conversations from the keyboard", async () => {
    const icon = button("New Rocket")!;
    // Focus alone doesn't open the list.
    await act(async () => icon.focus());
    expect(document.querySelector(".rail-popover")).toBeNull();
    await act(async () => icon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(railItem("Boss fight"));
    const key = async (name: string) => act(async () =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    await key("ArrowDown");
    expect(document.activeElement).toBe(railItem("Rocket fuel"));
    await key("ArrowUp");
    await key("ArrowUp");
    expect(document.activeElement).toBe(railItem("New conversation"));
    await key("ArrowLeft");
    expect(document.querySelector(".rail-popover")).toBeNull();
    expect(document.activeElement).toBe(icon);
    // Escape closes it and returns to the icon too.
    await act(async () => icon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await key("Escape");
    expect(document.querySelector(".rail-popover")).toBeNull();
    expect(document.activeElement).toBe(icon);
  });

  it("doesn't pull focus into a list that loads after the keyboard left", async () => {
    const icon = button("Old Garden")!;
    await act(async () => icon.focus());
    // The list is still loading when focus moves on.
    act(() => { icon.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    act(() => button("Search")!.focus());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector(".rail-popover")).toBeNull();
    expect(document.activeElement).toBe(button("Search"));
  });

  it("leaves an open project past the count in its place when another project moves", async () => {
    publishSidebarProjects([]);
    publishSidebarProjects(numbered(8));
    setVisibleProjects(5);
    await act(async () =>
      root.render(<ProjectRail projectId="p0" project={numbered(8)[0]}
        onNavigate={onNavigate} onLeave={onLeave} conversations={{ items: [], onOpen, onNew }} />),
    );
    await act(async () => button("Project 7")!.focus());
    await act(async () =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true })));
    expect(JSON.parse(localStorage.getItem("ohmygame-sidebar-projects")!).order).toEqual(["p6", "p7", "p5", "p4", "p3", "p2", "p1", "p0"]);
    // Moving the open project itself brings it into the list.
    await act(async () => button("Project 0")!.focus());
    await act(async () =>
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true })));
    expect(JSON.parse(localStorage.getItem("ohmygame-sidebar-projects")!).order).toEqual(["p6", "p7", "p5", "p4", "p0", "p3", "p2", "p1"]);
    await act(async () => setVisibleProjects(8));
  });

  it("lists an open project past the count without moving the others", async () => {
    vi.stubGlobal("ohMyGameDesktop", { platform: "darwin" });
    const recent = Array.from({ length: 8 }, (_, index) => project(`p${index}`, `Project ${index}`, `2026-10-2${index}T00:00:00Z`));
    publishSidebarProjects([]);
    publishSidebarProjects([...recent, project("older", "Older Cave", "2026-09-01T00:00:00Z")]);
    await act(async () =>
      root.render(<ProjectRail projectId="older" project={project("older", "Older Cave", "2026-09-01T00:00:00Z")}
        onNavigate={onNavigate} onLeave={onLeave} conversations={{ items: [], onOpen, onNew }} />),
    );
    const icons = [...sidebar().querySelectorAll(".sidebar-recent .sidebar-app[aria-haspopup]")].map((item) => item.getAttribute("aria-label"));
    expect(icons).toHaveLength(9);
    expect(icons.slice(0, 2)).toEqual(["Project 7", "Project 6"]);
    expect(icons.at(-1)).toBe("Older Cave");
    expect(sidebar().querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Older Cave");
  });

  it("puts the project's name and actions in the panels' top strips, beside the tabs", async () => {
    vi.stubGlobal("ohMyGameDesktop", { platform: "darwin" });
    const panel = (id: string, title: string, home: "left" | "center") => ({ id, title, icon: <span />, home, content: <p>{title}</p> });
    const layout = {
      left: { panels: ["chat"], active: "chat", size: 360 },
      center: { panels: ["game", "canvas"], active: "canvas", size: 0 },
      right: { panels: [], size: 300 },
      bottom: { panels: [], size: 200 },
    };
    const frame = (withLayout: boolean) => root.render(
      <ProjectFrame rail={<ProjectRail projectId="p" onNavigate={onNavigate} onLeave={onLeave} conversations={{ items: [], onOpen, onNew }} />}
        top={<ProjectTop name="Storm Ruins" menu={[]}><button type="button">Publish</button></ProjectTop>}>
        {withLayout ? <PanelLayout layout={layout} onChange={vi.fn()} empty={null}
          panels={[panel("chat", "Chat", "left"), panel("game", "Game", "center"), panel("canvas", "Canvas", "center")]} /> : null}
      </ProjectFrame>);
    await act(async () => frame(true));
    // No back or forward: the rail's corner only holds the window's controls.
    expect(sidebar().querySelector(".sidebar-titlebar")?.childElementCount).toBe(0);
    expect(button("Back")).toBeUndefined();
    // The left strip starts the title bar with the name; the chat there needs no tab of its own.
    const left = container.querySelector(".dock-area-left .dock-tabs.is-titlebar")!;
    expect(left.querySelector(".project-name")?.textContent).toBe("Storm Ruins");
    expect(left.querySelector<HTMLElement>(".dock-tab-list")!.hidden).toBe(true);
    // The middle strip keeps its tabs and ends the title bar with the actions.
    const center = container.querySelector(".dock-area-center .dock-tabs.is-titlebar")!;
    expect([...center.querySelectorAll("[role='tab']")].map((tab) => tab.textContent)).toEqual(["Game", "Canvas"]);
    expect(center.querySelector(".project-title-end")?.textContent).toBe("Publish");
    expect(container.querySelector(".project-top")?.textContent).toBe("");

    // Maximized, the middle fills the layout and holds the whole title bar; Restore brings the chat back.
    await act(async () => center.querySelector<HTMLButtonElement>("[aria-label='Maximize']")!.click());
    expect(container.querySelector(".dock-area-left")!.classList.contains("is-hidden")).toBe(true);
    expect(center.querySelector(".project-name")?.textContent).toBe("Storm Ruins");
    expect(center.querySelector(".project-title-end")?.textContent).toBe("Publish");
    await act(async () => center.querySelector<HTMLButtonElement>("[aria-label='Restore']")!.click());
    expect(container.querySelector(".dock-area-left")!.classList.contains("is-hidden")).toBe(false);
    expect(left.querySelector(".project-name")?.textContent).toBe("Storm Ruins");

    // The toggle hides the rail, and the choice is kept.
    await act(async () => button("Hide projects")!.click());
    expect(container.querySelector(".project-frame")!.classList.contains("is-rail-hidden")).toBe(true);
    expect(localStorage.getItem("ohmygame-project-rail-hidden")).toBe("true");
    await act(async () => button("Show projects")!.click());
    expect(container.querySelector(".project-frame")!.classList.contains("is-rail-hidden")).toBe(false);

    // Without a layout the frame's own row holds them.
    await act(async () => frame(false));
    expect(container.querySelector(".project-top .project-name")?.textContent).toBe("Storm Ruins");
    expect(container.querySelector(".project-top .project-title-end")?.textContent).toBe("Publish");
    localStorage.removeItem("ohmygame-project-rail-hidden");
  });
});
