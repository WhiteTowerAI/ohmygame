// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectPluginChange, ProjectPluginsView } from "../src/shared/plugins.js";

let view: ProjectPluginsView;
let changes: ProjectPluginChange[];
const api = {
  getProjectPlugins: vi.fn(async () => view),
  consentToPlugin: vi.fn(async () => {}),
  setProjectPluginVersion: vi.fn(async (_project: string, id: string, version: string | null) => {
    view = { ...view, plugins: view.plugins.map((plugin) => plugin.id === id ? { ...plugin, used: version ?? undefined, consented: true } : plugin) };
  }),
  listProjectPluginChanges: vi.fn(async () => changes),
  undoProjectPluginChange: vi.fn(async (_project: string, id: string) => {
    changes = changes.map((change) => change.id === id ? { ...change, undone: true } : change);
  }),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ProjectPluginsSheet } = await import("../src/renderer/project-plugins-sheet.js");
const { PluginChangesSheet } = await import("../src/renderer/project-plugin-contributions.js");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  view = {
    global: [{ id: "ohmygame:web-game-studio", displayName: "Web Game Studio", description: "Build web games." }],
    plugins: [
      { id: "ohmygame/godot", displayName: "Godot", description: "Godot games.", version: "1.0.0", used: "1.0.0", providesType: true, status: "active", capabilities: [], consented: true },
      { id: "acme/tiles", displayName: "Tiles", description: "Tile maps.", version: "2.1.0", providesType: false, capabilities: ["network:tiles.example.com"], consented: false },
    ],
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const toggle = (name: string) => document.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`)!;

it("locks global plugins and the type's plugin, and asks before turning one on here", async () => {
  const onChanged = vi.fn();
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} onChanged={onChanged} />));
  expect(toggle("Web Game Studio").disabled).toBe(true);
  expect(toggle("Web Game Studio").getAttribute("aria-checked")).toBe("true");
  expect(toggle("Godot").disabled).toBe(true);

  await act(async () => toggle("Tiles").click());
  expect(document.body.textContent).toContain("network:tiles.example.com");
  expect(api.setProjectPluginVersion).not.toHaveBeenCalled();
  expect(onChanged).not.toHaveBeenCalled();
  const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow and turn on")!;
  await act(async () => allow.click());
  expect(api.consentToPlugin).toHaveBeenCalledWith("acme/tiles", ["network:tiles.example.com"]);
  expect(api.setProjectPluginVersion).toHaveBeenCalledWith("p1", "acme/tiles", "2.1.0");
  expect(toggle("Tiles").getAttribute("aria-checked")).toBe("true");

  await act(async () => toggle("Tiles").click());
  expect(api.setProjectPluginVersion).toHaveBeenLastCalledWith("p1", "acme/tiles", null);
  // Each change tells the chat to read its skills and commands again.
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it("allows the type's plugin in a copied project without turning it off", async () => {
  view.plugins[0] = { ...view.plugins[0]!, status: "needs-approval", capabilities: ["processes:godot"] };
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} />));
  expect(document.body.textContent).toContain("Not yet allowed in this project");
  const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
  await act(async () => allow.click());
  expect(api.consentToPlugin).not.toHaveBeenCalled();
  expect(api.setProjectPluginVersion).toHaveBeenCalledWith("p1", "ohmygame/godot", "1.0.0");
});

it("waits for the agent before changing plugins", async () => {
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy onClose={() => {}} />));
  expect(document.body.textContent).toContain("Plugins change after the agent finishes.");
  expect(toggle("Tiles").disabled).toBe(true);
});

it("lists what plugins changed outside a turn and undoes one change", async () => {
  changes = [
    { id: "c2", plugin: "acme/maker", action: "command:upload", title: "Upload build", changed: ["build/index.html", "build/game.js"], at: "2026-10-31T10:00:00.000Z" },
    { id: "c1", plugin: "acme/maker", action: "command:setup", title: "Set up", changed: ["maker.json"], at: "2026-10-30T10:00:00.000Z", undone: true },
  ];
  const onUndone = vi.fn();
  await act(async () => root.render(<PluginChangesSheet projectId="p1" open busy={false} onClose={() => {}} onUndone={onUndone} />));
  expect(document.body.textContent).toContain("Upload build");
  expect(document.body.textContent).toContain("2 files");
  const undo = () => [...document.querySelectorAll("button")].filter((button) => button.textContent === "Undo");
  // The change already taken back has no Undo.
  expect(undo()).toHaveLength(1);
  await act(async () => undo()[0]!.click());
  expect(api.undoProjectPluginChange).toHaveBeenCalledWith("p1", "c2");
  expect(onUndone).toHaveBeenCalledTimes(1);
  expect(undo()).toHaveLength(0);
});
