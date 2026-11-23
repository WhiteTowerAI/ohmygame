// @vitest-environment happy-dom
import path from "node:path";
import { act, StrictMode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginSettingsStatus } from "../src/shared/plugin-settings.js";
import type { ProviderSummary } from "../src/shared/contracts.js";
import type { PluginMediaModelList, PluginSave3DModel } from "../src/shared/plugin-manifest.js";
import type { PluginUninstallPreview, StorePlugin, StorePluginConfiguration } from "../src/shared/plugins.js";

let configuration: StorePluginConfiguration;
let providers: ProviderSummary[] = [];
let uninstallPreview: PluginUninstallPreview;
const api = {
  readPluginToolAccess: vi.fn(async () => [{ plugin: "acme/maker", digest: "digest", key: "app", label: "TextEdit" }]),
  revokePluginToolAccess: vi.fn(async (_id: string, _key: string) => []),
  readPluginSettingsStatus: vi.fn(async (_id: string, _signal?: AbortSignal): Promise<PluginSettingsStatus> => ({ message: "Connected", actions: ["pair"] })),
  runPluginSettingsAction: vi.fn<(id: string, command: string) => Promise<PluginSettingsStatus>>(),
  testPluginMcpServer: vi.fn(async (_id: string, _server: string) => ({ status: "connected" as const, toolCount: 3, message: "\"Editor\" (http://127.0.0.1:8000/mcp) (3 tools)" })),
  restartStorePlugin: vi.fn(async () => {}),
  setStorePluginEveryProject: vi.fn(async () => {}),
  uninstallStorePlugin: vi.fn(async () => {}),
  readPluginUninstall: vi.fn(async () => uninstallPreview),
  readPluginUsage: vi.fn(async (): Promise<Record<string, string[]>> => ({ "2.0.0": ["Castle"] })),
  readPluginLog: vi.fn(async () => ({ entries: [{ at: "2026-11-04T08:00:00.000Z", level: "error", source: "host", text: "Its extension host stopped (1) while it was running" }], quarantined: true })),
  readStorePluginConfiguration: vi.fn(async () => configuration),
  saveStorePluginConfiguration: vi.fn(async () => configuration),
  listProviders: vi.fn(async () => providers),
  getPluginMediaModels: vi.fn(async (): Promise<PluginMediaModelList> => ({ kind: "image", discoverable: true, models: [{ id: "flux/schnell", name: "FLUX schnell", default: true, shown: true }] })),
  listPluginMediaModels: vi.fn(async (): Promise<PluginMediaModelList> => ({ kind: "image", discoverable: true, listedAt: "2026-11-13T00:00:00.000Z", skipped: 2, models: [
    { id: "flux/schnell", name: "FLUX schnell", default: true, shown: true },
    { id: "flux/pro", name: "FLUX pro", description: "Sharper pictures", default: false, shown: false },
  ] })),
  setPluginMediaModelsShown: vi.fn(async (): Promise<PluginMediaModelList> => ({ kind: "image", discoverable: true, listedAt: "2026-11-13T00:00:00.000Z", models: [
    { id: "flux/schnell", name: "FLUX schnell", default: true, shown: true },
    { id: "flux/pro", name: "FLUX pro", description: "Sharper pictures", default: false, shown: true },
  ] })),
  savePluginModel3D: vi.fn<(provider: string, edit: PluginSave3DModel) => Promise<PluginMediaModelList>>(),
  removePluginModel3D: vi.fn<(provider: string, id: string, revision: string, reset?: boolean) => Promise<PluginMediaModelList>>(),
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
const { groupStorePlugins, marketBlocks, StorePluginRow, StorePluginDetail: Detail, useEveryProjectSwitch, SessionBackgroundPrompt } = await import("../src/renderer/plugin-store.js");

function StorePluginDetail(props: Omit<ComponentProps<typeof Detail>, "everyProject">) {
  const everyProject = useEveryProjectSwitch(props.onChanged);
  return <Detail {...props} everyProject={everyProject} />;
}

const { PluginMediaModels } = await import("../src/renderer/plugin-media-models.js");

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
  adds: { projectTypes: ["Maker game"], panels: ["Preview"], commands: ["Upload"], mcpServers: ["Maker CLI"], modelProviders: [], agents: [], tools: 2, skills: 1, instructions: "Read the project first.\nKeep café and 中文 names." },
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

it("offers background running without changing it until the person enables it, and retains errors for retry", async () => {
  const bridge = { get: vi.fn(async () => false), set: vi.fn(async (_value: boolean) => true) };
  const previous = window.ohMyGameDesktop;
  window.ohMyGameDesktop = { ...previous, backgroundRunning: bridge } as NonNullable<typeof previous>;
  try {
    await act(async () => root.render(<SessionBackgroundPrompt />));
    expect(bridge.set).not.toHaveBeenCalled();
    bridge.set.mockRejectedValueOnce(new Error("Cannot save setting"));
    await act(async () => button("Enable").click());
    expect(host.textContent).toContain("Cannot save setting");
    await act(async () => button("Enable").click());
    expect(bridge.set).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toBe("");
    await act(async () => root.render(<SessionBackgroundPrompt key="dismiss" />));
    await act(async () => button("Not now").click());
    expect(bridge.set).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("");
  } finally { window.ohMyGameDesktop = previous; }
});

it("does not prompt when background running is enabled or unavailable", async () => {
  const previous = window.ohMyGameDesktop;
  try {
    window.ohMyGameDesktop = undefined;
    await act(async () => root.render(<SessionBackgroundPrompt />));
    expect(host.textContent).toBe("");
    window.ohMyGameDesktop = { ...previous, backgroundRunning: { get: async () => true, set: vi.fn() } } as NonNullable<typeof previous>;
    await act(async () => root.render(<SessionBackgroundPrompt key="enabled" />));
    expect(host.textContent).toBe("");
  } finally { window.ohMyGameDesktop = previous; }
});

it("keeps the background offer in the enabled session plugin's management section", async () => {
  const previous = window.ohMyGameDesktop;
  window.ohMyGameDesktop = { ...previous, backgroundRunning: { get: async () => false, set: vi.fn() } } as NonNullable<typeof previous>;
  const plugin = row("1.0.0", { everyProject: true, capabilities: ["sessions"], grants: { enabled: true, allowed: ["sessions"] } });
  const render = async (overrides: Partial<StorePlugin> = {}, safeMode = false) => {
    const group = groupStorePlugins([{ ...plugin, ...overrides }])[0]!;
    await act(async () => root.render(<StorePluginDetail group={group} safeMode={safeMode} onChanged={async () => {}} onRemoved={() => {}} />));
  };
  try {
    await render();
    expect(host.querySelector(".plugin-side .plugin-background-prompt")).not.toBeNull();
    for (const overrides of [{ everyProject: false }, { grants: { enabled: false, allowed: ["sessions"] } }, { grants: { enabled: true, allowed: [] } }, { capabilities: [] }] satisfies Partial<StorePlugin>[]) {
      await render(overrides);
      expect(host.querySelector(".plugin-background-prompt")).toBeNull();
    }
    await render({}, true);
    expect(host.querySelector(".plugin-background-prompt")).toBeNull();
  } finally { window.ohMyGameDesktop = previous; }
});

it("groups the store's rows by plugin, newest version first", () => {
  const groups = groupStorePlugins([row("2.0.0"), row("1.0.0"), row("1.0.0", { id: "acme/tiles" })]);
  expect(groups.map((group) => [group.plugin.id, group.plugin.version, group.versions.map((item) => item.version)])).toEqual([
    ["acme/maker", "2.0.0", ["2.0.0", "1.0.0"]],
    ["acme/tiles", "1.0.0", ["1.0.0"]],
  ]);
});

it("marks only the plugin a block names, though its repository holds others at that version", () => {
  const github = { type: "github" as const, repository: "acme/mono", ref: "main", commit: "a".repeat(40), release: "maker-v1.0.0" };
  const blocked = { repository: "acme/mono", id: "acme/tiles", version: "1.0.0", reason: "broken" };
  const market = { status: "ready" as const, plugins: [], blocked: [blocked] };
  expect(marketBlocks([row("1.0.0", { origin: github }), row("1.0.0", { id: "acme/tiles", origin: github })], market)).toEqual([blocked]);
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
  expect(document.querySelector(".plugin-instructions")?.textContent).toBe(row("2.0.0").adds.instructions);
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
  // Once that commit or version is installed, it isn't offered again before the next check.
  const updated = { type: "github", repository: "acme/maker", commit: "b".repeat(40) } as const;
  await act(async () => root.render(<StorePluginDetail key="updated" group={groupStorePlugins([row("2.0.0", { origin: updated })])[0]!} updates={[update]} onUpdateSource={onUpdateSource} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.body.textContent).not.toContain("Update to");
  const fromMarket = { id: "acme/maker", version: "2.0.0", source: { type: "market", id: "acme/maker", version: "2.0.0" } } as const;
  await act(async () => root.render(<StorePluginDetail key="market" group={group!} updates={[fromMarket]} onUpdateSource={onUpdateSource} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(document.body.textContent).not.toContain("Update to");
  await act(async () => root.render(<StorePluginDetail key="first" group={group!} updates={[update]} onUpdateSource={onUpdateSource} onAddAgain={onAddAgain} onChanged={async () => {}} onRemoved={() => {}} />));
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

it("offers longer field instructions without losing drafts, submitting, or expanding the input's label", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { settings: [
    { name: "path", type: "path", title: "Folder", description: "Choose the app's folder.\n\nFind it in your app settings.\nOfficial guide: https://example.com/guide\n<script>literal text</script> javascript:alert(1)" },
    { name: "token", type: "secret", title: "Token", description: "Keep this private." },
  ] })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  const input = host.querySelector<HTMLInputElement>('.plugin-configuration input')!;
  const help = host.querySelector<HTMLDetailsElement>('.plugin-setting-help')!;
  expect(input.labels?.[0]?.textContent).toBe("Folder");
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("Choose the app's folder.");
  expect(host.querySelectorAll('.plugin-setting-help')).toHaveLength(1);
  expect(help.open).toBe(false);
  await act(async () => type(input, "/unsaved"));
  await act(async () => help.querySelector("summary")!.click());
  expect(help.open).toBe(true);
  expect(input.value).toBe("/unsaved");
  expect(api.saveStorePluginConfiguration).not.toHaveBeenCalled();
  expect(help.querySelector("a")?.href).toBe("https://example.com/guide");
  expect(help.querySelector("a")?.target).toBe("_blank");
  expect(help.querySelectorAll("a")).toHaveLength(1);
  expect(help.querySelector("script")).toBeNull();
  expect(help.textContent).toContain("<script>literal text</script>");
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

it("lists a media provider's models, loads more from the vendor, and turns one on", async () => {
  providers = [{
    id: "plugin.acme.maker.fal", name: "fal", configured: true, status: "connected", methods: [], capabilities: ["image"],
    plugin: { id: "acme/maker", name: "Maker", keySetting: "token" },
  } as unknown as ProviderSummary];
  const [group] = groupStorePlugins([row("1.0.0", { adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: ["fal"], agents: [], tools: 0, skills: 0 } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((tab) => tab.textContent === "Settings")!.click());
  await act(async () => document.querySelector<HTMLElement>(".plugin-settings .settings-provider-row")!.click());
  const section = () => document.querySelector<HTMLElement>("[role=dialog] [aria-label='Image models']")!;
  expect(api.getPluginMediaModels).toHaveBeenCalledWith("plugin.acme.maker.fal", "image");
  expect(section().textContent).toContain("FLUX schnell");
  expect(section().textContent).toContain("Load fal's models to turn on more.");
  await act(async () => [...section().querySelectorAll("button")].find((button) => button.textContent === "Load models")!.click());
  expect(api.listPluginMediaModels).toHaveBeenCalledWith("plugin.acme.maker.fal", "image");
  // What was listed is off, under the hidden models, which loading opens.
  expect(section().textContent).toContain("2 models were left out");
  expect(section().textContent).toContain("Hidden models (1)");
  const pro = section().querySelector<HTMLInputElement>("input[aria-label='Enable FLUX pro']")!;
  expect(pro.checked).toBe(false);
  expect(section().textContent).toContain("flux/pro · Sharper pictures");
  await act(async () => pro.click());
  expect(api.setPluginMediaModelsShown).toHaveBeenCalledWith("plugin.acme.maker.fal", "image", ["flux/pro"], true);
  expect(section().querySelector<HTMLInputElement>("input[aria-label='Enable FLUX pro']")!.checked).toBe(true);
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

it("runs declared connection actions, preserves drafts and stops polling hidden settings without cancelling pairing", async () => {
  const { PluginSettingsActions } = await import("../src/renderer/plugin-settings-actions.js");
  const plugin = row("1.0.0", { everyProject: true, settingsView: { fields: ["path"], status: true, connection: true, actions: [{ id: "pair", title: "Bind account" }, { id: "cancel-pair", title: "Cancel binding" }] } });
  let finish!: (value: PluginSettingsStatus) => void;
  api.runPluginSettingsAction.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const render = (active: boolean, enabled = true) => root.render(<StrictMode><PluginSettingsActions plugin={plugin} active={active} enabled={enabled} /></StrictMode>);
  await act(async () => render(true));
  expect(host.textContent).toContain("Connected");
  await act(async () => button("Bind account").click());
  expect(api.runPluginSettingsAction).toHaveBeenCalledWith("acme/maker", "pair");
  expect(button("Bind account").disabled).toBe(true);
  await act(async () => render(false));
  expect(api.readPluginSettingsStatus.mock.calls.at(-1)?.[1]?.aborted).toBe(true);
  await act(async () => finish({ message: "Connected", code: { text: "/bind ABCD", expiresAt: Date.now() + 300000 }, actions: ["cancel-pair"] }));
  expect(api.runPluginSettingsAction).toHaveBeenCalledTimes(1);
  api.readPluginSettingsStatus.mockResolvedValueOnce({ message: "Waiting for your private message", actions: ["cancel-pair"] });
  await act(async () => render(true));
  expect(host.textContent).toContain("Waiting for your private message");
  expect(button("Cancel binding").disabled).toBe(false);
  api.runPluginSettingsAction.mockRejectedValueOnce(new Error("Disk is full"));
  await act(async () => button("Cancel binding").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Disk is full");
  await act(async () => render(true, false));
  expect(host.textContent).toContain("Turn this plugin on");
  expect(host.textContent).not.toContain("Cancel binding");
});

it("shows only declared connection fields while retaining legacy saved settings", async () => {
  const [group] = groupStorePlugins([row("1.0.0", { settingsView: { fields: ["path"], status: true, connection: true, actions: [] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(host.querySelectorAll(".plugin-configuration input")).toHaveLength(1);
  expect(host.querySelector<HTMLInputElement>(".plugin-configuration input")!.value).toBe("");
  const [statusOnly] = groupStorePlugins([row("1.0.0", { settings: [], settingsView: { fields: [], status: true, connection: true, actions: [] } })]);
  await act(async () => root.render(<StorePluginDetail group={statusOnly!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(host.querySelector('[role="tabpanel"][aria-label="Settings"] .plugin-connection')).not.toBeNull();
});

it("tests a plugin's MCP server from its Settings once it may run, with the guide beside it", async () => {
  const mcpServers = [{ id: "editor", title: "Editor MCP", url: "http://127.0.0.1:8000/mcp", setup: "Start the editor's server first.", docs: "https://example.com/mcp" }];
  const [waiting] = groupStorePlugins([row("1.0.0", { mcpServers })]);
  await act(async () => root.render(<StorePluginDetail group={waiting!} onChanged={async () => {}} onRemoved={() => {}} />));
  const panel = () => host.querySelector('[role="tabpanel"][aria-label="Settings"] .plugin-mcp-servers')!;
  expect(panel().textContent).toContain("Start the editor's server first.");
  expect(panel().textContent).toContain("http://127.0.0.1:8000/mcp");
  expect(panel().querySelector("a")?.getAttribute("href")).toBe("https://example.com/mcp");
  expect(panel().querySelector("a")?.textContent).toBe("Documentation");
  expect(panel().querySelector("button")!.disabled).toBe(true);
  const [ready] = groupStorePlugins([row("1.0.0", { mcpServers, runnable: true })]);
  await act(async () => root.render(<StorePluginDetail group={ready!} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => panel().querySelector("button")!.click());
  expect(api.testPluginMcpServer).toHaveBeenCalledWith("acme/maker", "editor");
  expect(panel().textContent).toContain("Connected · 3 tools");
  api.testPluginMcpServer.mockResolvedValueOnce({ status: "failed" as const, toolCount: 0, message: "Fill in Editor address", missingSettings: ["Editor address"] } as never);
  await act(async () => panel().querySelector("button")!.click());
  expect(panel().textContent).toContain("Fill in Editor address above, save, then test again.");
});

it("opens authorization only from explicit actions and reports saved configuration without secrets", async () => {
  const { PluginSettingsActions } = await import("../src/renderer/plugin-settings-actions.js");
  const link = { title: "Continue in Feishu", url: "https://open.feishu.cn/registration", expiresAt: Date.now() + 60000 };
  const plugin = row("1.0.0", { settingsView: { fields: ["path"], status: true, connection: true, actions: [{ id: "begin", title: "Create robot" }, { id: "finish", title: "Connect robot" }] } });
  const opened = vi.spyOn(window, "open").mockReturnValue(null);
  const changed = vi.fn();
  api.readPluginSettingsStatus.mockResolvedValueOnce({ message: "Waiting", link, actions: ["begin"] });
  try {
    await act(async () => root.render(<PluginSettingsActions plugin={plugin} active enabled onConfigurationChanged={changed} />));
    expect(opened).not.toHaveBeenCalled();
    await act(async () => button("Continue in Feishu").click());
    expect(opened).toHaveBeenCalledTimes(1);
    api.runPluginSettingsAction.mockResolvedValueOnce({ message: "Waiting", link: { ...link, url: `${link.url}?new` }, actions: ["finish"] });
    await act(async () => button("Create robot").click());
    expect(opened).toHaveBeenLastCalledWith(`${link.url}?new`, "_blank", "noopener,noreferrer");
    api.runPluginSettingsAction.mockResolvedValueOnce({ message: "Connecting", actions: [], configurationChanged: true });
    await act(async () => button("Connect robot").click());
    expect(changed).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("Connecting");
  } finally { opened.mockRestore(); }
});

it("refreshes settings saved by connection while retaining an unsaved manual draft", async () => {
  const { StorePluginSettings } = await import("../src/renderer/plugin-store.js");
  const plugin = row("1.0.0");
  const render = (revision: number) => root.render(<StorePluginSettings plugin={plugin} revision={revision} />);
  await act(async () => render(0));
  const input = host.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/my/manual/draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  configuration = { path: { type: "path", value: "/saved/by/connection" }, token: { type: "secret", configured: true } };
  await act(async () => render(1));
  expect(api.readStorePluginConfiguration).toHaveBeenCalledTimes(2);
  expect(input.value).toBe("/my/manual/draft");
  expect(host.textContent).not.toContain("fixture-secret");
});

it("offers revocable tool access even without configuration fields and retains failures", async () => {
  const { PluginToolAccess } = await import("../src/renderer/plugin-tool-access.js");
  const [group] = groupStorePlugins([row("1.0.0", { settings: [], adds: { ...row("1.0.0").adds, hooks: ["tool.beforeCall"] } })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  expect(button("Settings")).toBeTruthy();
  await act(async () => button("Settings").click());
  expect(host.textContent).toContain("TextEdit");
  api.revokePluginToolAccess.mockRejectedValueOnce(new Error("Cannot write access"));
  await act(async () => button("Revoke").click());
  expect(host.textContent).toContain("Cannot write access");
  expect(host.textContent).toContain("TextEdit");
  await act(async () => button("Revoke").click());
  expect(api.revokePluginToolAccess).toHaveBeenLastCalledWith("acme/maker", "app");
  expect(host.textContent).toContain("No remembered access");
  expect(document.activeElement?.textContent).toBe("Remembered access");
  await act(async () => root.render(<PluginToolAccess id="acme/maker" active={false} />));
});

it("retains a completed revocation when its settings tab is hidden without stealing focus", async () => {
  const { PluginToolAccess } = await import("../src/renderer/plugin-tool-access.js");
  let finish!: (value: never[]) => void;
  api.revokePluginToolAccess.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<PluginToolAccess id="acme/maker" active />));
  await act(async () => button("Revoke").click());
  await act(async () => root.render(<PluginToolAccess id="acme/maker" active={false} />));
  await act(async () => finish([]));
  expect(host.textContent).toContain("No remembered access");
  expect(document.activeElement?.textContent).not.toBe("Remembered access");
});


function editable3D(): PluginMediaModelList {
  const definition = { id: "mesh", title: "%mesh.title%", operations: ["text", "image"] as Array<"text" | "image">, polycount: { min: 48, max: 50000, default: 10000 }, texture: true };
  return { kind: "3d", discoverable: false, editor: { revision: "a".repeat(64), templates: [{ ...definition, title: "Mesh" }] }, models: [{ id: "mesh", name: "Mesh", default: true, shown: true, definition }] };
}

it("edits a plugin preset without rewriting omitted fields or localized titles, then adds, hides and removes a manual version", async () => {
  const list = editable3D();
  api.getPluginMediaModels.mockResolvedValueOnce(list);
  await act(async () => root.render(<PluginMediaModels providerId="plugin.a.meshy" providerName="Meshy" kind="3d" />));
  const edit = () => host.querySelector<HTMLButtonElement>("[aria-label='Edit Mesh']")!;
  await act(async () => edit().click());
  const form = () => host.querySelector<HTMLFormElement>("form")!;
  const number = () => form().querySelector<HTMLInputElement>("input[type=number]")!;
  await act(async () => type(number(), "3000"));
  const edited = structuredClone(list);
  edited.editor!.revision = "b".repeat(64);
  edited.models[0]!.edited = true;
  edited.models[0]!.definition!.polycount.default = 3000;
  api.savePluginModel3D.mockResolvedValueOnce(edited);
  await act(async () => form().requestSubmit());
  expect(api.savePluginModel3D).toHaveBeenLastCalledWith("plugin.a.meshy", { revision: "a".repeat(64), model: expect.objectContaining({ id: "mesh", title: "%mesh.title%", maxReferenceImages: undefined, pbr: undefined, defaults: undefined, polycount: { min: 48, max: 50000, default: 3000 } }) });
  expect(host.querySelector("form")).toBeNull();
  expect(document.activeElement).toBe(edit());
  await act(async () => edit().click());
  api.removePluginModel3D.mockResolvedValueOnce(list);
  await act(async () => button("Restore defaults").click());
  expect(api.removePluginModel3D).toHaveBeenLastCalledWith("plugin.a.meshy", "mesh", "b".repeat(64), true);

  await act(async () => button("Add").click());
  await act(async () => type(form().querySelector<HTMLInputElement>("input")!, "manual/version"));
  await act(async () => type(number(), "48"));
  const manual = structuredClone(list);
  manual.editor!.revision = "c".repeat(64);
  manual.models.push({ id: "manual/version", name: "manual/version", default: false, shown: true, custom: true, edited: true, definition: { ...list.models[0]!.definition!, id: "manual/version", polycount: { min: 48, max: 50000, default: 48 } } });
  api.savePluginModel3D.mockResolvedValueOnce(manual);
  await act(async () => form().requestSubmit());
  expect(api.savePluginModel3D).toHaveBeenLastCalledWith("plugin.a.meshy", expect.objectContaining({ templateId: "mesh", model: expect.objectContaining({ id: "manual/version", title: "", polycount: { min: 48, max: 50000, default: 48 } }) }));
  const hidden = structuredClone(manual); hidden.models[1]!.shown = false;
  api.setPluginMediaModelsShown.mockResolvedValueOnce(hidden);
  await act(async () => host.querySelector<HTMLInputElement>("[aria-label='Enable manual/version']")!.click());
  // Hiding retains the row, its editing controls and the model definition.
  expect(host.querySelector<HTMLInputElement>("[aria-label='Enable manual/version']")!.checked).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Delete manual/version']")!.click());
  api.removePluginModel3D.mockResolvedValueOnce(list);
  await act(async () => button("Delete").click());
  expect(api.removePluginModel3D).toHaveBeenLastCalledWith("plugin.a.meshy", "manual/version", "c".repeat(64));
  expect(host.textContent).not.toContain("manual/version");
});

it("retains a rejected draft and its original revision until explicitly cancelled and reopened", async () => {
  const list = editable3D(), latest = editable3D(); latest.editor!.revision = "b".repeat(64);
  api.getPluginMediaModels.mockResolvedValueOnce(list).mockResolvedValueOnce(latest);
  await act(async () => root.render(<PluginMediaModels providerId="plugin.a.meshy" providerName="Meshy" kind="3d" />));
  const edit = () => host.querySelector<HTMLButtonElement>("[aria-label='Edit Mesh']")!.click();
  await act(async () => edit());
  await act(async () => type(host.querySelector<HTMLInputElement>("form input[type=number]")!, "3000"));
  api.savePluginModel3D.mockRejectedValueOnce(new Error("The models changed. Reload them before saving your edit."));
  await act(async () => host.querySelector("form")!.requestSubmit());
  expect(host.querySelector<HTMLInputElement>("form input[type=number]")!.value).toBe("3000");
  expect(host.querySelector("form [role=alert]")!.textContent).toContain("models changed");
  expect(api.savePluginModel3D.mock.calls[0]![1].revision).toBe("a".repeat(64));
  await act(async () => button("Cancel").click());
  await act(async () => edit());
  api.savePluginModel3D.mockResolvedValueOnce(latest);
  await act(async () => host.querySelector("form")!.requestSubmit());
  expect(api.savePluginModel3D.mock.calls[1]![1].revision).toBe("b".repeat(64));
});

it("ignores stale model loads and saves after switching away and back to the same provider", async () => {
  let staleLoad!: (value: PluginMediaModelList) => void, staleSave!: (value: PluginMediaModelList) => void;
  const list = editable3D();
  api.getPluginMediaModels.mockReturnValueOnce(new Promise(resolve => { staleLoad = resolve; })).mockResolvedValueOnce(list).mockResolvedValueOnce(list);
  const render = async (id: string) => { await act(async () => root.render(<PluginMediaModels providerId={id} providerName={id} kind="3d" />)); };
  await render("A"); await render("B"); await render("A");
  await act(async () => staleLoad({ kind: "3d", discoverable: false, models: [] }));
  expect(host.textContent).toContain("Mesh");
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit Mesh']")!.click());
  api.savePluginModel3D.mockReturnValueOnce(new Promise(resolve => { staleSave = resolve; }));
  await act(async () => host.querySelector("form")!.requestSubmit());
  api.getPluginMediaModels.mockResolvedValueOnce(list).mockResolvedValueOnce(list);
  await render("B"); await render("A");
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Edit Mesh']")!.click());
  await act(async () => staleSave({ kind: "3d", discoverable: false, models: [] }));
  expect(host.querySelector("form")).not.toBeNull();
  expect(host.textContent).toContain("Mesh");
  expect(host.querySelector<HTMLInputElement>("form input[type=number]")!.disabled).toBe(false);
});

it("imports bounded JSON settings, preserves drafts after invalid files and ignores stale imports", async () => {
  configuration = { workflow: { type: "json", value: "{}" } };
  const [group] = groupStorePlugins([row("1.0.0", { settings: [{ name: "workflow", type: "json", title: "Workflow" }] })]);
  await act(async () => root.render(<StorePluginDetail group={group!} onChanged={async () => {}} onRemoved={() => {}} />));
  await act(async () => button("Settings").click());
  const textarea = document.querySelector<HTMLTextAreaElement>(".plugin-configuration textarea")!;
  const file = document.querySelector<HTMLInputElement>('.plugin-configuration input[type="file"]')!;
  expect(file.getAttribute("aria-label")).toBe("Import JSON for Workflow");
  const importFile = async (text: string, size = text.length, read?: () => Promise<string>) => {
    Object.defineProperty(file, "files", { configurable: true, value: [{ size, text: read ?? (async () => text) }] });
    await act(async () => file.dispatchEvent(new Event("change", { bubbles: true })));
  };
  const workflow = '{\n  "6": {"inputs": {"text": "森林"}}\n}';
  await importFile(workflow);
  expect(textarea.value).toBe(workflow);
  expect(textarea.checkValidity()).toBe(true);
  await act(async () => document.querySelector<HTMLFormElement>(".plugin-configuration form")!.requestSubmit());
  expect(api.saveStorePluginConfiguration).toHaveBeenCalledWith("acme/maker", { workflow });
  // The save fixture returns the previous stored value; the next import is a new draft.
  await importFile(workflow);
  for (const text of ["null", "[]", "{broken"]) {
    await importFile(text);
    expect(textarea.value).toBe(workflow);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("JSON object");
  }
  const read = vi.fn(async () => "{}");
  await importFile("", 256 * 1024 + 1, read);
  expect(read).not.toHaveBeenCalled();
  let resolve!: (text: string) => void;
  await importFile("", 10, () => new Promise(done => { resolve = done; }));
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, '{"edited":true}');
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => resolve('{"stale":true}'));
  expect(textarea.value).toBe('{"edited":true}');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{invalid");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(textarea.checkValidity()).toBe(false);
});

it("offers an in-place Update button on rows with available updates and shows its busy state", async () => {
  const onUpdate = vi.fn();
  const onOpen = vi.fn();
  const origin = { type: "github", repository: "acme/maker", commit: "c".repeat(40), release: "v1.0.0" } as const;
  const [group] = groupStorePlugins([row("1.0.0", { origin })]);
  const market = {
    status: "ready" as const,
    plugins: [{ id: "acme/maker", version: "1.2.0", displayName: "Maker", description: "Make games.", asks: [], adds: {}, featured: false, sourceVerified: false, repository: "https://github.com/acme/maker" }],
    blocked: [],
  };
  await act(async () => root.render(<StorePluginRow group={group!} market={market} selected={false} onUpdate={onUpdate} onOpen={onOpen} />));
  expect(host.querySelector(".installed-plugin-title")?.textContent).toBe("Maker");
  expect(host.querySelector(".installed-plugin-meta")?.textContent).toBe("1.0.0 @acme");
  const updateButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Update Maker"]');
  expect(updateButton()?.title).toBe("Update to 1.2.0");
  expect(updateButton()?.disabled).toBe(false);
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.textContent).not.toContain("Update available");
  await act(async () => updateButton()!.click());
  expect(onUpdate).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();

  await act(async () => root.render(<StorePluginRow group={group!} market={market} selected={false} updating onUpdate={onUpdate} onOpen={onOpen} />));
  expect(updateButton()?.disabled).toBe(true);
  expect(updateButton()?.getAttribute("aria-busy")).toBe("true");
  expect(updateButton()?.querySelector(".spin")).not.toBeNull();

  await act(async () => root.render(<StorePluginRow group={group!} market={market} selected={false} updateDisabled onUpdate={onUpdate} onOpen={onOpen} />));
  expect(updateButton()?.disabled).toBe(true);
  expect(updateButton()?.getAttribute("aria-busy")).toBeNull();

  // Source commit updates show the short commit in the tooltip; no update hides the button.
  const ghOrigin = { type: "github", repository: "acme/maker", commit: "a".repeat(40) } as const;
  const [ghGroup] = groupStorePlugins([row("1.0.0", { origin: ghOrigin })]);
  const sourceUpdate = { id: "acme/maker", commit: "b".repeat(40), source: { type: "github" as const, url: "https://github.com/acme/maker", commit: "b".repeat(40) } };
  await act(async () => root.render(<StorePluginRow group={ghGroup!} updates={[sourceUpdate]} selected={false} onUpdate={onUpdate} onOpen={onOpen} />));
  expect(updateButton()?.title).toBe("Update to bbbbbbb");

  await act(async () => root.render(<StorePluginRow group={ghGroup!} selected={false} onUpdate={onUpdate} onOpen={onOpen} />));
  expect(updateButton()).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>(".installed-plugin-open")!.click());
  expect(onOpen).toHaveBeenCalledOnce();
});
