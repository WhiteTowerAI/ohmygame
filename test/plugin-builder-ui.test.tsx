// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBuilder } from "../src/renderer/plugin-builder.js";
import { PluginUninstallButton } from "../src/renderer/plugin-controls.js";
import { readPluginBuilderInput, savePluginBuilderInput } from "../src/renderer/plugin-builder-drafts.js";
import { PERSONAL_MARKETPLACE, type PluginDetail } from "../src/shared/plugins.js";
import type { PluginSetupState } from "../src/shared/plugin-setup.js";
import i18next from "i18next";

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
let configuring: boolean;
let builtIn: boolean;
let hasConversation: boolean;
let enabled: boolean;
let draftIcon: PluginDetail["icon"];
let iconChanged: boolean;
let savedIcon: unknown;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  window.location.hash = `#/plugins/builder/${sessionId}`;
  installed = true;
  installationFailed = false;
  requests = [];
  configuring = false; builtIn = false; hasConversation = false; enabled = true;
  draftIcon = undefined; iconChanged = false; savedIcon = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    requests.push(`${method} ${route}`);
    if (route === `/plugins/setup-sessions/${sessionId}/icon` && method === "PUT") {
      const input = JSON.parse(String(init.body)); savedIcon = input;
      draftIcon = input.icon ?? undefined; iconChanged = true;
      return Response.json({ path: "review", installedRevision: installed ? revision : undefined, plugin: { ...plugin, installed: false, icon: draftIcon }, revision: "b".repeat(64), files: [], errors: [], checks: {} });
    }
    if (route === "/health") return Response.json({ status: "ok" });
    if (route === "/models") return Response.json({ models: [], providers: [] });
    if (route === `/plugins/setup-sessions/${sessionId}/install` && method === "POST") {
      installed = true;
      installationFailed = true;
      return Response.json({ error: "Configuration could not be saved" }, { status: 409 });
    }
    const currentState = { ...state, mode: configuring ? "configure" : "create", turns: hasConversation ? [{ id: "turn", conversationId: sessionId, status: "completed", items: [] }] : [] };
    if (route === `/plugins/setup-sessions/${sessionId}/conversation` && method === "DELETE") {
      hasConversation = false;
      return Response.json({ ...currentState, turns: [] });
    }
    if (route === `/plugins/${encodeURIComponent(plugin.id)}/configuration`) return Response.json({ fields: {}, values: {}, configuredSecrets: [], missing: [] });
    if (route === `/plugins/${encodeURIComponent(plugin.id)}/settings` && method === "PUT") {
      enabled = JSON.parse(init.body as string).enabled;
      return Response.json({ ...plugin, enabled });
    }
    if (method === "DELETE") {
      if (route === `/plugins/${encodeURIComponent(plugin.id)}`) installed = false;
      else if (route !== `/plugins/setup-sessions/${sessionId}`) throw new Error(`Unexpected request: ${route}`);
      return new Response(null, { status: 204 });
    }
    if (route === `/plugins/setup-sessions/${sessionId}`) return Response.json(installationFailed ? { ...state, status: "error", error: "Configuration could not be saved" } : installed ? currentState : { ...currentState, pluginId: undefined, status: "ready" });
    if (route === `/plugins/setup-sessions/${sessionId}/draft`) return Response.json(configuring ? { files: [], errors: [] } : { path: "review", revision: iconChanged ? "b".repeat(64) : revision, installedRevision: installed && !installationFailed ? revision : undefined, plugin: { ...plugin, installed: false, icon: draftIcon }, files: [], errors: [] });
    if (route === `/plugins/${encodeURIComponent(plugin.id)}`) return Response.json({ ...plugin, enabled, source: builtIn ? { type: "builtIn" } : plugin.source });
    throw new Error(`Unexpected request: ${route}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await i18next.changeLanguage("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe("Plugin Builder removal controls", () => {
  it("deletes an installed workspace independently of uninstalling its plugin", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Delete plugin draft").click());
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    confirm.mockReturnValue(true);
    await act(async () => button("Delete plugin draft").click());
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([`DELETE /plugins/setup-sessions/${sessionId}`]);
    expect(installed).toBe(true);
    expect(window.location.hash).toBe("#/settings/plugins");
  });

  it("opens built-in configuration on Setup with configuration prompts and independent workspace deletion", async () => {
    configuring = true; builtIn = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    expect(container.querySelector('[aria-label="Plugin preview"]')?.getAttribute("data-active-tab")).toBe("configuration");
    expect(container.querySelector("textarea")?.placeholder).toContain("configuration problem");
    expect(button("Uninstall plugin")).toBeNull();
    expect(button("Disable Review")).not.toBeNull();
    expect(container.textContent).not.toContain("Install plugin");
    await act(async () => button("Delete workspace").click());
    expect(requests).toContain(`DELETE /plugins/setup-sessions/${sessionId}`);
    expect(installed).toBe(true);
  });

  it("deletes only conversation history and keeps the installed draft open", async () => {
    hasConversation = true;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Delete conversation").click());
    expect(requests).toContain(`DELETE /plugins/setup-sessions/${sessionId}/conversation`);
    expect(requests).not.toContain(`DELETE /plugins/setup-sessions/${sessionId}`);
    expect(button("Delete conversation").disabled).toBe(true);
    expect(button("Delete plugin draft")).not.toBeNull();
    expect(installed).toBe(true);
    expect(window.location.hash).toBe(`#/plugins/builder/${sessionId}`);
  });

  it("toggles the installed plugin from Builder without uninstalling it", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Disable Review").click());
    expect(button("Enable Review").getAttribute("aria-checked")).toBe("false");
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    expect(installed).toBe(true);
  });

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
    expect(button("Delete plugin draft")).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Configuration could not be saved");
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update plugin");
    expect(retry?.disabled).toBe(false);
  });
});


describe("Plugin Builder icons", () => {
  const input = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const modalButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent === text)!;
  async function fill(element: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  it("translates picker labels, preset searches and validation notices into Chinese", async () => {
    await i18next.changeLanguage("zh-CN");
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("更改插件图标").click());
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("插件图标");
    await fill(input("搜索图标"), "终端");
    expect(document.querySelectorAll(".plugin-icon-grid button")).toHaveLength(1);
    expect(document.querySelector('[aria-label="终端 (terminal)"]')?.textContent).toBe("终端");
    await fill(input("预设 ID"), "invented");
    expect(modalButton("保存图标").disabled).toBe(true);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("从列表选择预设图标，或输入它的 ID。");
    await act(async () => modalButton("上传图片").click());
    await act(async () => {
      Object.defineProperty(input("插件图标图片"), "files", { value: [new File(["image"], "icon.gif")] });
      input("插件图标图片").dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("请选择不超过 1 MB 的 PNG 或 WebP 图片");
  });
  it("searches presets, validates entered IDs and makes the changed draft updateable", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Change plugin icon").click());
    await fill(input("Search icons"), "音乐");
    expect(document.querySelectorAll(".plugin-icon-grid button")).toHaveLength(1);
    await fill(input("Preset ID"), "invented");
    expect(modalButton("Save icon").disabled).toBe(true);
    await fill(input("Preset ID"), "music");
    expect(modalButton("Save icon").disabled).toBe(false);
    await act(async () => modalButton("Save icon").click());
    expect(savedIcon).toEqual({ revision, icon: { type: "preset", id: "music" } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === "Update plugin")?.disabled).toBe(false);
    expect(requests.filter(request => request === `GET /plugins/setup-sessions/${sessionId}/draft`)).toHaveLength(1);
    expect(requests.filter(request => request === `GET /plugins/${encodeURIComponent(plugin.id)}`)).toHaveLength(1);
    await act(async () => button("Change plugin icon").click());
    await fill(input("Preset ID"), "image");
    await act(async () => modalButton("Save icon").click());
    expect(savedIcon).toEqual({ revision: "b".repeat(64), icon: { type: "preset", id: "image" } });
  });
  it("validates package paths and restores the default icon", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Change plugin icon").click());
    await act(async () => modalButton("Package image").click());
    await fill(input("Plugin icon path"), "https://example.com/logo.png");
    expect(modalButton("Save icon").disabled).toBe(true);
    await fill(input("Plugin icon path"), "./assets/logo.png");
    expect(modalButton("Save icon").disabled).toBe(false);
    await act(async () => modalButton("Use default").click());
    expect(savedIcon).toEqual({ revision, icon: null });
  });
  it("uploads a chosen image without reusing the controlled preset input", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:icon-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    await act(async () => button("Change plugin icon").click());
    await act(async () => modalButton("Upload image").click());
    expect(modalButton("Choose file")).not.toBeNull();
    expect(document.querySelector(".plugin-file-picker-name")?.textContent).toBe("No file selected");
    const file = new File(["test-image"], "logo.webp", { type: "image/webp" });
    await act(async () => { Object.defineProperty(input("Plugin icon image"), "files", { value: [file] }); input("Plugin icon image").dispatchEvent(new Event("change", { bubbles: true })); });
    expect(document.querySelector(".plugin-file-picker-name")?.textContent).toBe("logo.webp");
    expect(createUrl).toHaveBeenCalledWith(file);
    await act(async () => { modalButton("Save icon").click(); await vi.waitFor(() => expect(savedIcon).toBeDefined()); });
    expect(savedIcon).toEqual({ revision, image: { mediaType: "image/webp", data: btoa("test-image") } });
    expect(log.mock.calls.flat().join(" ")).not.toContain("controlled input");
  });

  it("closes on Escape and returns focus to the edit button", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} />));
    button("Change plugin icon").focus();
    await act(async () => button("Change plugin icon").click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Change plugin icon"));
  });
});
