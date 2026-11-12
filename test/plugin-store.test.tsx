// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderSummary } from "../src/shared/contracts.js";
import type { PluginUninstallPreview, StorePlugin, StorePluginConfiguration } from "../src/shared/plugins.js";

let configuration: StorePluginConfiguration;
let providers: ProviderSummary[] = [];
let uninstallPreview: PluginUninstallPreview;
const api = {
  restartStorePlugin: vi.fn(async () => {}),
  setStorePluginEveryProject: vi.fn(async () => {}),
  uninstallStorePlugin: vi.fn(async () => {}),
  readPluginUninstall: vi.fn(async () => uninstallPreview),
  readPluginUsage: vi.fn(async (): Promise<Record<string, string[]>> => ({ "2.0.0": ["Castle"] })),
  readPluginLog: vi.fn(async () => ({ entries: [{ at: "2026-11-04T08:00:00.000Z", level: "error", source: "host", text: "Its extension host stopped (1) while it was running" }], quarantined: true })),
  readStorePluginConfiguration: vi.fn(async () => configuration),
  saveStorePluginConfiguration: vi.fn(async () => configuration),
  listProviders: vi.fn(async () => providers),
  readPluginSkill: vi.fn(async () => ({ id: "skills/maker/SKILL.md", content: "---\nname: maker\ndescription: Build with Maker.\n---\n\n# Using Maker" })),
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
  revision: "a".repeat(64),
  displayName: "Maker",
  description: "Make games.",
  capabilities: ["native", "network:api.example.com"],
  grants: { enabled: true, allowed: ["native"] },
  bundled: false,
  everyProject: false,
  settings: [
    { name: "path", type: "path", title: "Engine path" },
    { name: "token", type: "secret", title: "Token" },
  ],
  examples: [],
  skills: [{ id: "skills/maker/SKILL.md", name: "maker", description: "Build with Maker." }],
  adds: { projectTypes: ["Maker game"], panels: ["Preview"], commands: ["Upload"], mcpServers: ["Maker CLI"], modelProviders: [], agents: [], tools: 2, skills: 1 },
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
  uninstallPreview = { last: false, settings: 0, dataBytes: 0, projectFiles: [], projects: [] };
  providers = [];
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

it("lists what it asks for, turns it on with its one switch and nothing to confirm, and uninstalls one version", async () => {
  const onChanged = vi.fn(async () => {});
  const onRemoved = vi.fn();
  const [group] = groupStorePlugins([row("2.0.0"), row("1.0.0")]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={onChanged} onRemoved={onRemoved} />));
  expect(document.body.textContent).toContain("Connect to these sitesapi.example.com");
  expect(document.querySelector(".plugin-store-adds")!.textContent).toContain("MCP serviceMaker CLI");
  // Turning it on is allowing it, so nothing asks first; nor is there a second switch to stop it everywhere.
  await act(async () => document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="Turn Maker on in every project"]')!.click());
  expect(document.querySelector("[role=dialog]")).toBeNull();
  expect(api.setStorePluginEveryProject).toHaveBeenCalledWith("acme/maker", true);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toContain("Disable everywhere");
  expect(document.body.textContent).not.toContain("Allow what this plugin asks for");

  const uninstall = [...document.querySelectorAll(".plugin-store-versions button")] as HTMLButtonElement[];
  expect(uninstall).toHaveLength(2);
  await act(async () => uninstall[1]!.click());
  expect(api.uninstallStorePlugin).not.toHaveBeenCalled();
  await act(async () => [...document.querySelectorAll(".ui-dialog button, [role=dialog] button")].find((item) => item.textContent === "Uninstall")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(api.uninstallStorePlugin).toHaveBeenCalledWith("acme/maker", "1.0.0", { keepData: false });
  // Another version is still installed, so the page stays.
  expect(onRemoved).not.toHaveBeenCalled();
});

it("updates from where it came from, removes older versions no project uses, and says a local one is added again", async () => {
  const onUpdateSource = vi.fn();
  const onAddAgain = vi.fn();
  const origin = { type: "github", repository: "acme/maker", commit: "a".repeat(40) } as const;
  const update = { id: "acme/maker", commit: "b".repeat(40), source: { type: "github", url: "https://github.com/acme/maker", commit: "b".repeat(40) } } as const;
  const [group] = groupStorePlugins([row("2.0.0", { origin }), row("1.5.0", { origin }), row("1.0.0", { origin })]);
  await act(async () => root.render(<StorePluginDetail group={group!} updates={[update]} onUpdateSource={onUpdateSource} onAddAgain={onAddAgain} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => button("Update to bbbbbbb").click());
  expect(onUpdateSource).toHaveBeenCalledWith(update);
  // Castle uses the newest; the two older ones are used nowhere.
  expect([...document.querySelectorAll(".plugin-store-versions li")].map((item) => item.textContent)).toEqual([
    "v2.0.0Uninstall", "v1.5.0No project uses itUninstall", "v1.0.0No project uses itUninstall",
  ]);
  await act(async () => button("Remove 2 unused versions").click());
  expect(api.uninstallStorePlugin).toHaveBeenNthCalledWith(1, "acme/maker", "1.5.0");
  expect(api.uninstallStorePlugin).toHaveBeenNthCalledWith(2, "acme/maker", "1.0.0");
  expect(document.body.textContent).not.toContain("Added from this computer");

  await act(async () => root.render(<StorePluginDetail key="local" group={groupStorePlugins([row("1.0.0")])[0]!} onAddAgain={onAddAgain} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.body.textContent).toContain("Added from this computer, so it has nowhere to update from.");
  await act(async () => button("Add again").click());
  expect(onAddAgain).toHaveBeenCalled();
});

it("says a plugin stopped after crashing, shows its log, and turns it on again", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { quarantined: true })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.body.textContent).toContain("Stopped after it kept crashing");
  await act(async () => [...document.querySelectorAll("button")].find((item) => item.textContent === "View log")!.click());
  const dialog = document.querySelector("[role=dialog]")!;
  expect(api.readPluginLog).toHaveBeenCalledWith("acme/maker");
  expect(dialog.querySelector("pre")!.textContent).toBe("2026-11-04T08:00:00.000Z ERROR [host] Its extension host stopped (1) while it was running");
  await act(async () => [...dialog.querySelectorAll("button")].find((item) => item.textContent === "Turn on again")!.click());
  expect(api.restartStorePlugin).toHaveBeenCalledWith("acme/maker");
  // Turning it off from its log turns it off in every project.
  await act(async () => [...document.querySelectorAll("button")].find((item) => item.textContent === "View log")!.click());
  await act(async () => [...document.querySelector("[role=dialog]")!.querySelectorAll("button")].find((item) => item.textContent === "Turn off")!.click());
  expect(api.setStorePluginEveryProject).toHaveBeenCalledWith("acme/maker", false);
});

it("says what uninstalling the last version removes and leaves, and can keep its settings and data", async () => {
  uninstallPreview = { last: true, settings: 2, dataBytes: 3 * 1024, projectFiles: ["./.maker/"], projects: ["Castle", "Forest"] };
  const onRemoved = vi.fn();
  const [group] = groupStorePlugins([row("1.0.0")]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={onRemoved} />));
  await act(async () => document.querySelector<HTMLButtonElement>(".plugin-store-versions button")!.click());
  const dialog = () => document.querySelector("[role=dialog]")!;
  expect(api.readPluginUninstall).toHaveBeenCalledWith("acme/maker", "1.0.0");
  expect(dialog().textContent).toContain("What you allowed it to do");
  expect(dialog().textContent).toContain("2 saved settings and sign-ins");
  expect(dialog().textContent).toContain("Its data folder (3 KB)");
  expect(dialog().textContent).toContain("CastleForest");
  expect(dialog().textContent).toContain("./.maker/");
  // Kept, the settings and data are no longer listed as removed.
  await act(async () => dialog().querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  expect(dialog().textContent).not.toContain("Its data folder");
  await act(async () => [...dialog().querySelectorAll("button")].find((item) => item.textContent === "Uninstall")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(api.uninstallStorePlugin).toHaveBeenCalledWith("acme/maker", "1.0.0", { keepData: true });
  expect(onRemoved).toHaveBeenCalled();
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
  expect(panel("About").textContent).toContain("in that project alone");
  expect(panel("Skills").hidden).toBe(true);

  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.textContent?.startsWith("Skills"))!.click());
  expect(panel("Skills").hidden).toBe(false);
  expect(panel("Skills").querySelector("[role=switch]")).toBeNull();
  await act(async () => panel("Skills").querySelector<HTMLButtonElement>(".plugin-skill-open")!.click());
  expect(api.readPluginSkill).toHaveBeenCalledWith("acme/maker", "skills/maker/SKILL.md");
  expect(panel("Skills").textContent).toContain("Using Maker");
  expect(panel("Skills").textContent).not.toContain("name: maker");
  // Unsaved settings stay on the page while another tab shows.
  expect(panel("Settings").querySelector("form")).not.toBeNull();
});

it("leaves out what projects turn on for a plugin that only adds model providers and agents", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { appOnly: true, skills: [], adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: ["NVIDIA"], agents: ["Gemini CLI"], tools: 0, skills: 0 } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.body.textContent).toContain("NVIDIA");
  expect(document.body.textContent).not.toContain("in that project alone");
});

it("shows a plugin's model providers as in Settings, and sets a key in a dialog as the plugin's setting", async () => {
  providers = [{
    id: "plugin.acme.maker.nvidia", name: "NVIDIA", configured: false, status: "not_configured", methods: [], capabilities: ["language"],
    plugin: { id: "acme/maker", name: "Maker", baseUrl: "https://integrate.example/v1", keySetting: "token" },
  } as unknown as ProviderSummary];
  const [group] = groupStorePlugins([row("1.0.0", { adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: ["NVIDIA"], agents: [], tools: 0, skills: 0 } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === "Settings")!.click());
  const panel = document.querySelector<HTMLElement>(".plugin-settings")!;
  expect(panel.textContent).toContain("NVIDIA");
  // Its key is set with the provider, so the form keeps only the other settings.
  expect(panel.textContent).toContain("Engine path");
  expect(panel.textContent).not.toContain("Token");
  await act(async () => panel.querySelector<HTMLElement>(".settings-provider-row button")!.click());
  const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
  expect(dialog.textContent).toContain("https://integrate.example/v1");
  await act(async () => type(dialog.querySelector<HTMLInputElement>("input[type=password]")!, " nv-key "));
  await act(async () => dialog.querySelector("form")!.requestSubmit());
  expect(api.saveStorePluginConfiguration).toHaveBeenCalledWith("acme/maker", { token: "nv-key" });
});

it("tries an example in a project it suits, turning it on there, or in a new one", async () => {
  const onTry = vi.fn(async () => {});
  const allowed = { grants: { enabled: true, allowed: ["native", "network:api.example.com"] } };
  const [group] = groupStorePlugins([row("1.0.0", { ...allowed, examples: ["Build a level"], appliesTo: ["general", "ohmygame/godot:godot-game"] })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  // By each project's own kind: a Web game is no General project, and a story suits neither.
  const listed = [...document.querySelectorAll(".project-switcher-item strong")].map((item) => item.textContent);
  expect(listed).toEqual(["Godot game"]);
  const target = { turnOn: "acme/maker", mention: { name: "maker", marketplaceId: "acme", displayName: "Maker" }, newProjectType: "general" };
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-item")!.click());
  expect(onTry).toHaveBeenLastCalledWith(target, "Build a level", "godot");
  // The app leaves for the conversation; opening the picker again starts over.
  await act(async () => button("Build a level").click());
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
  expect(onTry).toHaveBeenLastCalledWith(target, "Build a level", undefined);
});

it("offers Try without allowing first, holds it back in safe mode, and offers no new project of a type only a plugin adds", async () => {
  const onTry = vi.fn(async () => {});
  // Trying it turns it on in the project, which allows it.
  const [waiting] = groupStorePlugins([row("1.0.0", { examples: ["Build a level"] })]);
  await act(async () => root.render(<StorePluginDetail group={waiting!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  expect(button("Build a level").disabled).toBe(false);
  const [safe] = groupStorePlugins([row("1.0.0", { examples: ["Build a level"], grants: { enabled: false, allowed: [] } })]);
  await act(async () => root.render(<StorePluginDetail key="safe" group={safe!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  expect(button("Build a level").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("Try now");

  const [typed] = groupStorePlugins([row("1.0.0", { id: "acme/typed", examples: ["Build a level"], appliesTo: ["acme/typed:game"], grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail key="typed" group={typed!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  expect(document.querySelector(".project-switcher-footer")).toBeNull();
});

it("offers a new project of the app's type a plugin's own type goes with", async () => {
  const onTry = vi.fn(async () => {});
  const [group] = groupStorePlugins([row("1.0.0", { examples: ["Build a level"], appliesTo: ["ohmygame/godot:godot-game"], grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
  expect(onTry).toHaveBeenCalledWith({ turnOn: "acme/maker", mention: { name: "maker", marketplaceId: "acme", displayName: "Maker" }, newProjectType: "godot-game" }, "Build a level", undefined);
});

it("keeps a Skill's content below empty metadata", async () => {
  vi.mocked(api.readPluginSkill).mockResolvedValueOnce({ id: "skills/maker/SKILL.md", content: "---\r\n---\r\n# First part\r\n\r\n---\r\nLast part" });
  const [group] = groupStorePlugins([row("1.0.0", { grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.textContent?.startsWith("Skills"))!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".plugin-skill-open")!.click());
  const content = document.querySelector(".plugin-skill-content")!;
  expect(content.textContent).toContain("First part");
  expect(content.textContent).toContain("Last part");
});

it("offers a new project of the plugin's own type over a general one", async () => {
  const onTry = vi.fn(async () => {});
  const [group] = groupStorePlugins([row("1.0.0", { id: "ohmygame/godot", examples: ["Build a level"], appliesTo: ["general", "ohmygame/godot:godot-game"], grants: { enabled: true, allowed: ["native", "network:api.example.com"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  await act(async () => button("Build a level").click());
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
  expect(onTry).toHaveBeenCalledWith({ turnOn: "ohmygame/godot", mention: { name: "godot", marketplaceId: "ohmygame", displayName: "Maker" }, newProjectType: "godot-game" }, "Build a level", undefined);
});

it("tries a plugin on in every project by mentioning it, in projects of a kind it names", async () => {
  const onTry = vi.fn(async () => {});
  const [group] = groupStorePlugins([row("1.0.0", {
    id: "acme/worlds", displayName: "Worlds", capabilities: [], grants: { enabled: true, allowed: [] }, settings: [], everyProject: true,
    examples: ["Build a world"], appliesTo: ["web-game"],
    adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 1 },
  })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} onTry={onTry} />));
  expect(document.querySelector('[role=switch][aria-label="Turn Worlds on in every project"]')!.getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Build a world").click());
  const picker = () => document.querySelector(".project-switcher")?.textContent ?? document.body.textContent ?? "";
  expect(picker()).toContain("Web game");
  expect(picker()).not.toContain("Godot game");
  await act(async () => document.querySelector<HTMLButtonElement>(".project-switcher-footer button")!.click());
  expect(onTry).toHaveBeenCalledWith({ turnOn: "acme/worlds", mention: { name: "worlds", marketplaceId: "acme", displayName: "Worlds" }, newProjectType: "web-game" }, "Build a world", undefined);
});

it("says a preinstalled plugin came with the app, where from, and that it can be uninstalled", async () => {
  const [group] = groupStorePlugins([row("1.0.0", {
    capabilities: [], grants: { enabled: true, allowed: [] }, settings: [], everyProject: true, preinstalled: true,
    origin: { type: "github", repository: "example/tools", commit: "abc123" },
  })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.querySelector("h1")!.textContent).toContain("Included");
  expect(document.querySelector<HTMLAnchorElement>('a[href="https://github.com/example/tools"]')).not.toBeNull();
  await act(async () => button("Uninstall").click());
  expect(document.body.textContent).toContain("Version 1.0.0 and its files");
});

it("goes back to About when the open tab goes away with the newest version", async () => {
  const props = { onChanged: async () => {}, onRemoved: () => {} };
  const [both] = groupStorePlugins([row("2.0.0"), row("1.0.0", { skills: [] })]);
  await act(async () => root.render(<StorePluginDetail group={both!} {...props} />));
  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((item) => item.textContent?.startsWith("Skills"))!.click());
  const [older] = groupStorePlugins([row("1.0.0", { skills: [], settings: [] })]);
  await act(async () => root.render(<StorePluginDetail group={older!} {...props} />));
  expect(document.querySelector<HTMLElement>('[role=tabpanel][aria-label="About"]')!.hidden).toBe(false);
});

it("offers plugins and their Skills for browsing by what they add", () => {
  expect(storePluginContributions(row("1.0.0"))).toEqual(["projectType", "skills", "mcp"]);
  expect(storePluginContributions(row("1.0.0", { skills: [], adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 } }))).toEqual([]);
});
