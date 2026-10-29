// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectState } from "../src/shared/contracts.js";

const project = (id: string, name: string, updatedAt: string) => ({ id, name, type: "web-game", updatedAt }) as ProjectState;
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  listProjects: async () => [project("old", "Old Garden", "2026-10-01T00:00:00Z"), project("new", "New Rocket", "2026-10-20T00:00:00Z")],
}));
const { CommandMenuHost, openCommandMenu, useCommands, useLeaveGuard } = await import("../src/renderer/command-menu.js");

let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const navigate = vi.fn((hash: string) => { window.location.hash = hash; });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "#/projects";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  navigate.mockClear();
  vi.unstubAllGlobals();
});

const press = (key: string) => act(async () => {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }));
});
const options = () => [...document.querySelectorAll('[role="option"]')].map((option) => option.querySelector(".ui-command-label")?.textContent);
const option = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(label))!;

/** A page that adds a command and, when given one, guards leaving. */
function Page({ guard }: { guard?: (go: () => void) => void }) {
  useCommands(() => [{ id: "show-code", group: "Panels", label: "Show Code", run: () => navigate("#code") }]);
  useLeaveGuard(guard ?? ((go) => go()));
  return null;
}

it("lists the page's commands, the app's pages and projects, newest first, and toggles on ⌘K", async () => {
  await act(async () => root.render(<><Page /><CommandMenuHost navigate={navigate} /></>));
  await press("k");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  const labels = options();
  expect(labels[0]).toBe("Show Code");
  expect(labels).toEqual(expect.arrayContaining(["Home", "Projects", "New project", "General", "Switch between dark and light"]));
  expect(labels.indexOf("New Rocket")).toBeLessThan(labels.indexOf("Old Garden"));
  await act(async () => option("Old Garden").click());
  expect(navigate).toHaveBeenCalledWith("#/projects/old");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await press("k");
  await press("k");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("leaves the page through its guard, from the menu and from ⌘N and ⌘,", async () => {
  const pending: (() => void)[] = [];
  await act(async () => root.render(<><Page guard={(go) => pending.push(go)} /><CommandMenuHost navigate={navigate} /></>));
  await press(",");
  await press("n");
  await act(async () => openCommandMenu());
  await act(async () => option("Library").click());
  // Nothing leaves until the page lets it, as an open project saves its design first.
  expect(navigate).not.toHaveBeenCalled();
  expect(pending).toHaveLength(3);
  await act(async () => { for (const go of pending) go(); });
  expect(navigate.mock.calls.map(([hash]) => hash)).toEqual(["#/settings/general", "#/", "#/library"]);
  // The page's own commands don't leave it, so they run at once.
  await act(async () => openCommandMenu());
  await act(async () => option("Show Code").click());
  expect(navigate).toHaveBeenLastCalledWith("#code");
});

it("leaves Settings alone on ⌘, when it is already open", async () => {
  window.location.hash = "#/settings/appearance";
  await act(async () => root.render(<CommandMenuHost navigate={navigate} />));
  await press(",");
  expect(navigate).not.toHaveBeenCalled();
});
