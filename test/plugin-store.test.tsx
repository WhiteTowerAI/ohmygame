// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StorePlugin, StorePluginConfiguration } from "../src/shared/plugins.js";

let configuration: StorePluginConfiguration;
const api = {
  consentToPlugin: vi.fn(async () => {}),
  setStorePluginEnabled: vi.fn(async () => {}),
  uninstallStorePlugin: vi.fn(async () => {}),
  readStorePluginConfiguration: vi.fn(async () => configuration),
  saveStorePluginConfiguration: vi.fn(async () => configuration),
  readPluginSkill: vi.fn(async () => ({ id: "skills/maker/SKILL.md", content: "# Using Maker" })),
  listProjects: vi.fn(async () => [
    { id: "web", name: "Web game", type: "web-game", updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "story", name: "Story", type: "interactive-story", updatedAt: "2026-01-03T00:00:00.000Z" },
    { id: "godot", name: "Godot game", type: "godot-game", pluginType: { id: "ohmygame/godot:godot-game", plugin: "ohmygame/godot", preview: "web-build" }, updatedAt: "2026-01-01T00:00:00.000Z" },
  ]),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { groupStorePlugins, storePluginContributions, StorePluginDetail } = await import("../src/renderer/plugin-store.js");

const row = (version: string, overrides: Partial<StorePlugin> = {}): StorePlugin => ({
  id: "acme/maker",
  version,
  displayName: "Maker",
  description: "Make games.",
  capabilities: ["native", "network:api.example.com"],
  grants: { enabled: true, allowed: ["native"] },
  bundled: false,
  settings: [
    { name: "path", type: "path", title: "Engine path" },
    { name: "token", type: "secret", title: "Token" },
  ],
  examples: [],
  skills: [{ id: "skills/maker/SKILL.md", name: "maker", description: "Build with Maker." }],
  adds: { projectTypes: ["Maker game"], panels: ["Preview"], commands: ["Upload"], mcpServers: ["Maker CLI"], tools: 2, skills: 1 },
  ...overrides,
});

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  configuration = { path: { type: "path", value: null }, token: { type: "secret", configured: true } };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

it("groups the store's rows by plugin, newest version first", () => {
  const groups = groupStorePlugins([row("2.0.0"), row("1.0.0"), row("1.0.0", { id: "acme/tiles" })]);
  expect(groups.map((group) => [group.plugin.id, group.plugin.version, group.versions.map((item) => item.version)])).toEqual([
    ["acme/maker", "2.0.0", ["2.0.0", "1.0.0"]],
    ["acme/tiles", "1.0.0", ["1.0.0"]],
  ]);
});

it("asks for what isn't allowed yet, switches off, and uninstalls one version", async () => {
  const onChanged = vi.fn(async () => {});
  const onRemoved = vi.fn();
  const [group] = groupStorePlugins([row("2.0.0"), row("1.0.0")]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={onChanged} onRemoved={onRemoved} />));
  expect(document.body.textContent).toContain("network:api.example.com");
  expect(document.querySelector(".plugin-store-adds")!.textContent).toContain("MCP serviceMaker CLI");
  await act(async () => button("Allow").click());
  expect(api.consentToPlugin).toHaveBeenCalledWith("acme/maker", ["native", "network:api.example.com"]);
  expect(onChanged).toHaveBeenCalledTimes(1);

  await act(async () => document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Disable Maker"]')!.click());
  expect(api.setStorePluginEnabled).toHaveBeenCalledWith("acme/maker", false);

  const uninstall = [...document.querySelectorAll(".plugin-store-versions button")] as HTMLButtonElement[];
  expect(uninstall).toHaveLength(2);
  await act(async () => uninstall[1]!.click());
  expect(api.uninstallStorePlugin).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll(".ui-dialog button, [role=dialog] button")].find((item) => item.textContent === "Uninstall")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(api.uninstallStorePlugin).toHaveBeenCalledWith("acme/maker", "1.0.0");
  // Another version is still installed, so the page stays.
  expect(onRemoved).not.toHaveBeenCalled();
});

it("offers Uninstall only for the versions that didn't ship with the app", async () => {
  const [group] = groupStorePlugins([row("2.0.0", { bundled: true }), row("1.0.0")]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  const items = [...document.querySelectorAll(".plugin-store-versions li")];
  expect(items.map((item) => [item.textContent?.startsWith("v2.0.0"), !!item.querySelector("button")])).toEqual([[true, false], [false, true]]);
});

it("keeps a bundled plugin installed and its saved secret unless cleared", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { bundled: true, grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.querySelectorAll(".plugin-store-versions button")).toHaveLength(0);
  expect(document.body.textContent).not.toContain("Allow what this plugin asks for");

  const [pathInput, tokenInput] = [...document.querySelectorAll<HTMLInputElement>(".plugin-configuration input")];
  expect(tokenInput!.placeholder).not.toBe("");
  await act(async () => type(pathInput!, "/opt/maker"));
  // Typing a secret and emptying it again leaves the saved one alone.
  await act(async () => type(tokenInput!, "x"));
  await act(async () => type(tokenInput!, ""));
  await act(async () => document.querySelector<HTMLFormElement>(".plugin-configuration form")!.requestSubmit());
  expect(api.saveStorePluginConfiguration).toHaveBeenCalledWith("acme/maker", { path: "/opt/maker" });
});

it("keeps a setting changed again while the last change saves", async () => {
  const [group] = groupStorePlugins([row("1.0.0")]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  let finish!: () => void;
  api.saveStorePluginConfiguration.mockImplementationOnce(() => new Promise((resolve) => {
    finish = () => resolve({ ...configuration, path: { type: "path", value: "/first" } });
  }));
  const pathInput = document.querySelector<HTMLInputElement>(".plugin-configuration input")!;
  await act(async () => type(pathInput, "/first"));
  await act(async () => document.querySelector<HTMLFormElement>(".plugin-configuration form")!.requestSubmit());
  await act(async () => type(pathInput, "/second"));
  await act(async () => finish());
  expect(pathInput.value).toBe("/second");
  expect(document.querySelector<HTMLButtonElement>(".plugin-configuration button[type=submit]")!.disabled).toBe(false);
});

it("shows the plugin's description, Skills and settings under tabs, without a switch per Skill", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { beta: true, longDescription: "All about Maker.", grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  const panel = (label: string) => document.querySelector<HTMLElement>(`[role=tabpanel][aria-label="${label}"]`)!;
  expect(document.querySelector("h1")!.textContent).toContain("Beta");
  expect(panel("About").hidden).toBe(false);
  expect(panel("About").textContent).toContain("All about Maker.");
  expect(panel("Skills").hidden).toBe(true);

  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.textContent?.startsWith("Skills"))!.click());
  expect(panel("Skills").hidden).toBe(false);
  expect(panel("Skills").querySelector("[role=switch]")).toBeNull();
  await act(async () => panel("Skills").querySelector<HTMLButtonElement>(".plugin-skill-open")!.click());
  expect(api.readPluginSkill).toHaveBeenCalledWith("acme/maker", "skills/maker/SKILL.md");
  expect(panel("Skills").textContent).toContain("Using Maker");
  // Unsaved settings stay on the page while another tab shows.
  expect(panel("Settings").querySelector("form")).not.toBeNull();
});

it("tries an example in a project it suits, turning it on there, or in a new one", async () => {
  const onTry = vi.fn(async () => {});
  const allowed = { grants: { enabled: true, allowed: ["native", "network:api.example.com"] } };
  const [group] = groupStorePlugins([row("1.0.0", { ...allowed, examples: ["Build a level"], appliesTo: ["general", "ohmygame/godot:godot-game"] })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  // A Web game's project file says general; a story suits neither.
  const listed = [...document.querySelectorAll(".project-switcher-item strong")].map((item) => item.textContent);
  expect(listed).toEqual(["Web game", "Godot game"]);
  const target = { turnOn: "acme/maker", newProjectType: "general" };
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-item")!.click());
  expect(onTry).toHaveBeenLastCalledWith(target, "Build a level", "web");
  // The app leaves for the conversation; opening the picker again starts over.
  await act(async () => button("Build a level").click());
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
  expect(onTry).toHaveBeenLastCalledWith(target, "Build a level", undefined);
});

it("holds Try back until what the plugin asks for is allowed, and offers no new project of a type only a plugin adds", async () => {
  const onTry = vi.fn(async () => {});
  const [waiting] = groupStorePlugins([row("1.0.0", { examples: ["Build a level"] })]);
  await act(async () => root.render(<StorePluginDetail group={waiting!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  expect(button("Build a level").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Try now");
  expect(document.querySelector(".plugins-note")!.textContent).toBe("Allow what it asks for to try it.");

  const [typed] = groupStorePlugins([row("1.0.0", { id: "acme/typed", examples: ["Build a level"], appliesTo: ["acme/typed:game"], grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail key="typed" group={typed!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  expect(document.querySelector(".project-switcher-footer")).toBeNull();
});

it("offers format 2 plugins and their Skills for browsing by what they add", () => {
  expect(storePluginContributions(row("1.0.0"))).toEqual(["projectType", "skills", "mcp"]);
  expect(storePluginContributions(row("1.0.0", { skills: [], adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], tools: 0, skills: 0 } }))).toEqual([]);
});
