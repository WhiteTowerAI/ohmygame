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
  setProjectPlugin: vi.fn(async (_project: string, id: string, on: boolean, version?: string) => {
    view = { ...view, plugins: view.plugins.map((plugin) => plugin.id === id ? { ...plugin, used: on ? version ?? plugin.version : undefined, consented: true } : plugin) };
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
    plugins: [
      { id: "ohmygame/godot", displayName: "Godot", description: "Godot games.", version: "1.0.0", used: "1.0.0", providesType: true, status: "active", capabilities: [], consented: true, everyProject: false, versions: ["1.0.0"] },
      { id: "ohmygame/game-studio", displayName: "Game Studio", description: "Plan games.", version: "1.2.0", used: "1.2.0", providesType: false, status: "active", capabilities: [], consented: true, everyProject: true, versions: ["1.2.0"] },
      { id: "acme/tiles", displayName: "Tiles", description: "Tile maps.", version: "2.1.0", providesType: false, capabilities: ["native", "network:tiles.example.com"], consented: false, everyProject: false, versions: ["2.1.0"] },
    ],
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const toggle = (name: string) => document.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`)!;

it("switches each plugin here, locks the type's plugin, and asks before turning one on", async () => {
  const onChanged = vi.fn();
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} onChanged={onChanged} />));
  expect(toggle("Godot").disabled).toBe(true);
  // One on in every project is on here, says so, and can be turned off here.
  expect(toggle("Game Studio").getAttribute("aria-checked")).toBe("true");
  expect(toggle("Game Studio").disabled).toBe(false);
  expect(document.querySelector(".project-plugin:nth-child(3)")?.textContent).toContain("Every project");
  await act(async () => toggle("Game Studio").click());
  expect(api.setProjectPlugin).toHaveBeenLastCalledWith("p1", "ohmygame/game-studio", false, undefined);
  expect(toggle("Game Studio").getAttribute("aria-checked")).toBe("false");

  await act(async () => toggle("Tiles").click());
  expect(document.body.textContent).toContain("network:tiles.example.com");
  expect(document.querySelector('.ui-dialog [role="alert"]')?.textContent).toContain("OhMyGame can't limit it");
  expect(api.setProjectPlugin).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
  const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow and turn on")!;
  await act(async () => allow.click());
  expect(api.consentToPlugin).toHaveBeenCalledWith("acme/tiles", ["native", "network:tiles.example.com"]);
  expect(api.setProjectPlugin).toHaveBeenLastCalledWith("p1", "acme/tiles", true, undefined);
  expect(toggle("Tiles").getAttribute("aria-checked")).toBe("true");

  await act(async () => toggle("Tiles").click());
  expect(api.setProjectPlugin).toHaveBeenLastCalledWith("p1", "acme/tiles", false, undefined);
  // Each change tells the chat to read its skills and commands again.
  expect(onChanged).toHaveBeenCalledTimes(3);
});

it("keeps the older version a project uses when allowing it", async () => {
  view.plugins[2] = { ...view.plugins[2]!, used: "2.0.0", status: "needs-approval", consented: true };
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} />));
  const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
  await act(async () => allow.click());
  expect(api.setProjectPlugin).toHaveBeenCalledWith("p1", "acme/tiles", true, "2.0.0");
});

it("moves a project off an uninstalled version, and finds or removes an uninstalled plugin", async () => {
  view.plugins[1] = { ...view.plugins[1]!, used: "1.0.0", status: "version-not-installed" };
  view.plugins[2] = { ...view.plugins[2]!, version: "2.0.0", used: "2.0.0", status: "not-installed", consented: true };
  const onOpenPlugins = vi.fn();
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} onOpenPlugins={onOpenPlugins} />));
  const find = (text: string) => [...document.querySelectorAll("button")].find((button) => button.textContent === text)!;
  await act(async () => find("Use 1.2.0").click());
  expect(api.setProjectPlugin).toHaveBeenCalledWith("p1", "ohmygame/game-studio", true, "1.2.0");
  // Nothing installed to switch: it is found again in Plugins, or taken out here.
  expect(toggle("Tiles")).toBeNull();
  await act(async () => find("Find in Plugins").click());
  expect(onOpenPlugins).toHaveBeenCalled();
  await act(async () => find("Remove from project").click());
  expect(api.setProjectPlugin).toHaveBeenLastCalledWith("p1", "acme/tiles", false, undefined);
});

it("keeps a project on its version when a newer one is installed, and moves it either way", async () => {
  view.plugins[2] = { ...view.plugins[2]!, version: "2.1.0", used: "2.0.0", status: "active", consented: true, versions: ["2.1.0", "2.0.0", "1.0.0"] };
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} />));
  const select = document.querySelector<HTMLButtonElement>('button[aria-label="Version of Tiles in this project"]')!;
  expect(select.textContent).toContain("2.0.0");
  await act(async () => select.click());
  const option = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === text)!;
  expect(option("2.1.0 (newest)")).toBeDefined();
  await act(async () => option("2.1.0 (newest)").click());
  expect(api.setProjectPlugin).toHaveBeenLastCalledWith("p1", "acme/tiles", true, "2.1.0");
});

it("allows the type's plugin in a copied project without turning it off", async () => {
  view.plugins[0] = { ...view.plugins[0]!, status: "needs-approval", capabilities: ["processes:godot"] };
  await act(async () => root.render(<ProjectPluginsSheet projectId="p1" open busy={false} onClose={() => {}} />));
  expect(document.body.textContent).toContain("Not yet allowed in this project");
  const allow = [...document.querySelectorAll("button")].find((button) => button.textContent === "Allow")!;
  await act(async () => allow.click());
  expect(api.consentToPlugin).not.toHaveBeenCalled();
  expect(api.setProjectPlugin).toHaveBeenCalledWith("p1", "ohmygame/godot", true, undefined);
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

it("says when a plugin change isn't recorded yet, and when it was recorded late", async () => {
  changes = [
    { id: "c3", plugin: "acme/maker", action: "command:upload", title: "Upload build", changed: [], at: "2026-10-31T10:00:00.000Z", unrecorded: true },
    { id: "c2", plugin: "acme/maker", action: "command:setup", title: "Set up", changed: ["maker.json"], at: "2026-10-30T10:00:00.000Z", late: true },
  ];
  await act(async () => root.render(<PluginChangesSheet projectId="p1" open busy={false} onClose={() => {}} onUndone={() => {}} />));
  expect(document.body.textContent).toContain("not recorded yet");
  expect(document.body.textContent).toContain("Recorded late");
  // Each says what to do about it, so it wraps rather than being cut off.
  expect(document.querySelectorAll("small.project-plugin-note")).toHaveLength(2);
  // The unrecorded one has no file count and no Undo; the late one has both.
  expect(document.body.textContent).not.toContain("0 files");
  expect([...document.querySelectorAll("button")].filter((button) => button.textContent === "Undo")).toHaveLength(1);
});
