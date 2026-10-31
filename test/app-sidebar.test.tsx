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
const { ProjectRail, publishRecentProjects, refreshRecentProject } =
  await import("../src/renderer/app-sidebar.js");

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

async function render(active: "home" | "library" | "settings" = "home") {
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
  const sections = [
    ...sidebar().querySelectorAll(":scope > .sidebar-group")[1]!.children,
  ].map((item) => item.textContent);
  expect(sections).toEqual([
    "Home",
    "Projects",
    "Library",
    "Community",
    "Plugins",
  ]);
  expect(sidebar().querySelector('[aria-current="page"]')?.textContent).toBe(
    "Home",
  );
  expect(sidebar().textContent).not.toContain("Web Game");
  button("Library")!.click();
  expect(onNavigate).toHaveBeenCalledWith("library");
  expect(container.querySelector(".page-sheet")?.textContent).toBe("Page");
});

it("lists recent projects newest first, folds them, and opens one", async () => {
  // Library has no project list of its own, so the sidebar loads one.
  await render("library");
  const recent = () =>
    [...sidebar().querySelectorAll(".sidebar-recent .sidebar-item")].map(
      (item) => item.textContent,
    );
  expect(recent()).toEqual(["New Rocket", "Old Garden"]);

  // A page that reloads the list hands it over, so a rename shows at once.
  await act(async () =>
    publishRecentProjects([{ ...projects[0]!, name: "Renamed Garden" }]),
  );
  expect(recent()).toEqual(["Renamed Garden"]);
  // A project renamed from inside shows its new name too.
  await act(async () => refreshRecentProject({ ...projects[0]!, name: "Garden" }));
  expect(recent()).toEqual(["Garden"]);
  await act(async () =>
    publishRecentProjects([{ ...projects[0]!, name: "Renamed Garden" }]),
  );

  await act(async () => button("Recent projects")!.click());
  expect(recent()).toEqual([]);
  expect(localStorage.getItem("ohmygame-sidebar-recent-open")).toBe("false");
  await act(async () => button("Recent projects")!.click());
  button("Renamed Garden")!.click();
  expect(window.location.hash).toBe("#/projects/old");
});

it("keeps five recent projects", async () => {
  await render("library");
  await act(async () =>
    publishRecentProjects(Array.from({ length: 7 }, (_, index) => ({
      ...projects[0]!, id: `p${index}`, name: `Project ${index}`, updatedAt: `2026-10-2${index}T00:00:00Z`,
    }))),
  );
  const recent = [...sidebar().querySelectorAll(".sidebar-recent .sidebar-item")].map((item) => item.textContent);
  // Projects in the sections above lists the rest.
  expect(recent).toEqual(["Project 6", "Project 5", "Project 4", "Project 3", "Project 2"]);
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
  const library = button("Library")!;
  expect(library.title).toBe("");
  await act(async () => library.focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Library");
  await act(async () => library.blur());
  // Another page's frame opens the same way.
  await act(async () =>
    root.render(
      <PageFrame active="library" onNavigate={onNavigate}>
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
  expect(menuLabels()).toEqual(["Sign in…", "Settings", "About OhMyGame"]);
  await act(async () => button("Sign in…")!.click());
  expect(auth.openSignIn).toHaveBeenCalledOnce();

  await act(async () => account.click());
  await act(async () => button("About OhMyGame")!.click());
  expect(window.location.hash).toBe("#/settings/about");
});

it("opens settings and account from the signed-in menu", async () => {
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
    "About OhMyGame",
  ]);
  await act(async () => button("Account")!.click());
  expect(window.location.hash).toBe("#/settings/account");
  await act(async () => account.click());
  await act(async () => button("Settings")!.click());
  expect(onNavigate).toHaveBeenCalledWith("settings");
});

it("opens the command menu from Search, which shows its shortcut", async () => {
  const opened = vi.fn();
  window.addEventListener("ohmygame:command-menu", opened);
  await render();
  expect(button("Search")!.querySelector("kbd")?.textContent).toMatch(/^(⌘K|Ctrl\+K)$/);
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
    publishRecentProjects(projects);
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

  it("keeps only the way home, the recent projects, search and the account", async () => {
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

  it("lists an open project that isn't among the recent ones, and saves before going back", async () => {
    vi.stubGlobal("ohMyGameDesktop", { platform: "darwin" });
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const recent = Array.from({ length: 8 }, (_, index) => project(`p${index}`, `Project ${index}`, `2026-10-2${index}T00:00:00Z`));
    publishRecentProjects([...recent, project("older", "Older Cave", "2026-09-01T00:00:00Z")]);
    await act(async () =>
      root.render(<ProjectRail projectId="older" project={project("older", "Older Cave", "2026-09-01T00:00:00Z")}
        onNavigate={onNavigate} onLeave={onLeave} conversations={{ items: [], onOpen, onNew }} />),
    );
    const icons = [...sidebar().querySelectorAll(".sidebar-recent .sidebar-app[aria-haspopup]")].map((item) => item.getAttribute("aria-label"));
    expect(icons).toHaveLength(8);
    expect(icons.at(-1)).toBe("Older Cave");
    expect(sidebar().querySelector('[aria-current="page"]')?.getAttribute("aria-label")).toBe("Older Cave");
    onLeave.mockClear();
    await act(async () => button("Back")!.click());
    expect(onLeave).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
    back.mockRestore();
  });

  it("leads with back and forward where the system draws the title bar, and leaves them to the Windows one", async () => {
    const rail = () => root.render(<ProjectRail projectId="p" onNavigate={onNavigate} onLeave={onLeave} conversations={{ items: [], onOpen, onNew }} />);
    vi.stubGlobal("ohMyGameDesktop", { platform: "linux" });
    await act(async () => rail());
    expect(sidebar().querySelector(".sidebar-titlebar [aria-label='Back']")).not.toBeNull();
    vi.stubGlobal("ohMyGameDesktop", { platform: "win32", windowMenu: { popup: vi.fn() } });
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => rail());
    expect(sidebar().querySelector(".sidebar-titlebar")).toBeNull();
  });
});
