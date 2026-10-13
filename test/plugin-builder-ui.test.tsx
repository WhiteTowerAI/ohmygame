// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBuilder } from "../src/renderer/plugin-builder.js";
import { PluginUninstallButton } from "../src/renderer/plugin-controls.js";
import { readPluginBuilderInput, savePluginBuilderInput } from "../src/renderer/plugin-builder-drafts.js";
import { PERSONAL_MARKETPLACE, type PluginDetail } from "../src/shared/plugins.js";
import type { PluginSetupState } from "../src/shared/plugin-setup.js";

const sessionId = "a1234567-1234-1234-1234-123456789abc";
const plugin: PluginDetail = {
  id: "personal:review", name: "review", displayName: "Review", description: "Review game design",
  marketplace: PERSONAL_MARKETPLACE, source: { type: "directory" },
  installed: true, enabled: true, skills: [], connections: [],
};
const state: PluginSetupState = {
  id: sessionId, pluginId: plugin.id, title: plugin.displayName, status: "installed",
  createdAt: 0, updatedAt: 0, busy: false, turns: [],
};
const revision = "a".repeat(64);
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let installed: boolean;
let installationFailed: boolean;
let requests: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  window.location.hash = `#/plugins/builder/${sessionId}`;
  installed = true;
  installationFailed = false;
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    requests.push(`${method} ${route}`);
    if (route === "/health") return Response.json({ status: "ok" });
    if (route === "/models") return Response.json({ models: [], providers: [] });
    if (route === `/plugins/setup-sessions/${sessionId}/install` && method === "POST") {
      installed = true;
      installationFailed = true;
      return Response.json({ error: "Configuration could not be saved" }, { status: 409 });
    }
    if (method === "DELETE") {
      if (route === `/plugins/${encodeURIComponent(plugin.id)}`) installed = false;
      else if (route !== `/plugins/setup-sessions/${sessionId}`) throw new Error(`Unexpected request: ${route}`);
      return new Response(null, { status: 204 });
    }
    if (route === `/plugins/setup-sessions/${sessionId}`) return Response.json(installationFailed ? { ...state, status: "error", error: "Configuration could not be saved" } : installed ? state : { ...state, pluginId: undefined, status: "ready" });
    if (route === `/plugins/setup-sessions/${sessionId}/draft`) return Response.json({ path: "review", revision, installedRevision: installed && !installationFailed ? revision : undefined, plugin: { ...plugin, installed: false }, files: [], errors: [] });
    if (route === `/plugins/${encodeURIComponent(plugin.id)}`) return Response.json(plugin);
    throw new Error(`Unexpected request: ${route}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe("Plugin Builder removal controls", () => {
  it("honors cancellation and changes the installed view back to an installable draft after uninstalling", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Uninstall plugin").click());
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    confirm.mockReturnValue(true);
    await act(async () => button("Uninstall plugin").click());
    expect(requests).toContain(`DELETE /plugins/${encodeURIComponent(plugin.id)}`);
    expect(button("Uninstall plugin")).toBeNull();
    expect(button("Delete plugin draft")).not.toBeNull();
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Install plugin");
    expect(install?.disabled).toBe(false);
  });

  it("deletes an uninstalled workspace and its unsent input before returning to Plugins", async () => {
    installed = false;
    savePluginBuilderInput(sessionId, { prompt: "Unsent draft" }, localStorage);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Delete plugin draft").click());
    expect(requests).toContain(`DELETE /plugins/setup-sessions/${sessionId}`);
    expect(readPluginBuilderInput(sessionId, localStorage).prompt).toBe("");
    expect(window.location.hash).toBe("#/settings/plugins");
  });

  it("does not offer uninstalling a built-in plugin", async () => {
    await act(async () => root.render(<PluginUninstallButton plugin={{ ...plugin, source: { type: "builtIn" } }} onUninstall={() => {}} />));
    expect(button("Uninstall plugin")).toBeNull();
  });

  it("refreshes after a partial installation failure so uninstall and retry stay available", async () => {
    installed = false;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Install plugin")!;
    await act(async () => install.click());
    expect(button("Uninstall plugin")).not.toBeNull();
    expect(button("Delete plugin draft")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Configuration could not be saved");
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update plugin");
    expect(retry?.disabled).toBe(false);
  });
});
