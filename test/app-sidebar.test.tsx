// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  listProjects: async () => projects,
  waitForRuntime: async () => undefined,
  getProjectCover: async () => undefined,
}));
const { PageFrame } = await import("../src/renderer/page-frame.js");
const { publishRecentProjects, takeProjectSearchFocus } =
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

  await act(async () => button("Recent projects")!.click());
  expect(recent()).toEqual([]);
  expect(localStorage.getItem("ohmygame-sidebar-recent-open")).toBe("false");
  await act(async () => button("Recent projects")!.click());
  button("Renamed Garden")!.click();
  expect(window.location.hash).toBe("#/projects/old");
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

it("opens settings, account and billing from the signed-in menu", async () => {
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
    "Billing",
    "About OhMyGame",
  ]);
  await act(async () => button("Billing")!.click());
  expect(window.location.hash).toBe("#/settings/billing");
  await act(async () => account.click());
  await act(async () => button("Settings")!.click());
  expect(onNavigate).toHaveBeenCalledWith("settings");
});

it("searches from the Projects page's search field", async () => {
  await render();
  button("Search")!.click();
  expect(onNavigate).toHaveBeenCalledWith("projects");
  expect(takeProjectSearchFocus()).toBe(true);
  expect(takeProjectSearchFocus()).toBe(false);
});
