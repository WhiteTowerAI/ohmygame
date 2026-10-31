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
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { groupStorePlugins, StorePluginDetail } = await import("../src/renderer/plugin-store.js");

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
  adds: { projectTypes: ["Maker game"], panels: ["Preview"], commands: ["Upload"], tools: 2, skills: 1 },
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
