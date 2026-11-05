// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginBuilder } from "../src/renderer/plugin-builder.js";
import { readPluginBuilderInput, savePluginBuilderInput } from "../src/renderer/plugin-builder-drafts.js";
import type { PluginIcon } from "../src/shared/plugins.js";
import type { PluginSetupState } from "../src/shared/plugin-setup.js";
import i18next from "i18next";

vi.mock("../src/renderer/auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/renderer/auth.js")>(),
  useAuth: () => ({ state: { status: "signed-out" }, openSignIn: () => {} }),
}));

const sessionId = "a1234567-1234-1234-1234-123456789abc";
const storeId = "personal/review";
const state: PluginSetupState = {
  id: sessionId, pluginId: storeId, title: "Review", status: "installed",
  createdAt: 0, updatedAt: 0, busy: false, turns: [],
};
const stored = {
  id: storeId, version: "0.1.0", displayName: "Review", description: "Review game design", bundled: false, everyProject: true,
  capabilities: [], examples: [], settings: [], skills: [], adds: { projectTypes: [], panels: [], commands: [], mcpServers: [], modelProviders: [], agents: [], tools: 0, skills: 0 },
};
const draftPlugin = { id: storeId, version: "0.1.0", displayName: "Review", description: "Review game design", appWide: true, asks: [], skills: [], mcpServers: [], settings: false, adds: stored.adds };
const revision = "a".repeat(64);
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let installed: boolean;
let installationFailed: boolean;
let requests: string[];
let hasConversation: boolean;
let everyProject: boolean;
let draftIcon: PluginIcon | undefined;
let iconChanged: boolean;
let savedIcon: unknown;
let hasSettings: boolean;
let updated: boolean;
let hasDraft: boolean;
let working: boolean;
let sessions: Array<{ id: string; title: string; status: string; pluginId?: string; createdAt: number; updatedAt: number }>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  window.location.hash = `#/plugins/builder/${sessionId}`;
  installed = true;
  installationFailed = false;
  requests = [];
  hasConversation = false; everyProject = true;
  draftIcon = undefined; iconChanged = false; savedIcon = undefined;
  hasSettings = false; updated = false; hasDraft = true; working = false; sessions = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
    const method = init.method ?? "GET";
    requests.push(`${method} ${route}`);
    if (route === `/plugins/setup-sessions/${sessionId}/icon` && method === "PUT") {
      const input = JSON.parse(String(init.body)); savedIcon = input;
      draftIcon = input.icon ?? undefined; iconChanged = true;
      return Response.json({ path: "review", installedRevision: installed ? revision : undefined, plugin: { ...draftPlugin, icon: draftIcon }, revision: "b".repeat(64), files: [], errors: [], checks: {} });
    }
    if (route === "/health") return Response.json({ status: "ok" });
    if (route === "/plugins/setup-sessions" && method === "GET") return Response.json(sessions);
    if (route === "/plugins/setup-sessions" && method === "POST") return Response.json({ ...state, id: "created" });
    if (route === `/plugins/setup-sessions/${sessionId}/draft` && !hasDraft) return Response.json({ files: [], errors: [] });
    if (route === `/plugins/setup-sessions/${sessionId}` && !hasDraft) return Response.json({ ...state, pluginId: undefined, title: "New plugin", status: working ? "working" : "idle", busy: working });
    if (route === "/models") return Response.json({ models: [], providers: [] });
    if (route === `/plugins/setup-sessions/${sessionId}/install` && method === "POST") {
      if (hasSettings) {
        updated = true;
        return Response.json(state);
      }
      installed = true;
      installationFailed = true;
      return Response.json({ error: "Configuration could not be saved" }, { status: 409 });
    }
    const currentState = { ...state, pluginId: storeId, mode: "create", turns: hasConversation ? [{ id: "turn", conversationId: sessionId, status: "completed", items: [] }] : [] };
    if (route === `/plugins/setup-sessions/${sessionId}/conversation` && method === "DELETE") {
      hasConversation = false;
      return Response.json({ ...currentState, turns: [] });
    }
    if (route === "/plugin-store/plugins") return Response.json(installed ? [{ ...stored, revision: updated ? "new" : "old", ...(hasSettings ? { settings: [{ name: "token", type: "text", title: "Token", required: false }] } : {}), everyProject, grants: { enabled: true, allowed: [] } }] : []);
    if (route === `/plugin-store/${storeId}/configuration`) return Response.json({ token: { type: "text", value: null } });
    if (route === `/plugin-store/${storeId}/every-project` && method === "PUT") {
      everyProject = JSON.parse(init.body as string).on;
      return new Response(null, { status: 204 });
    }
    if (route === `/plugin-store/${storeId}/0.1.0` && method === "DELETE") {
      installed = false;
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      if (route !== `/plugins/setup-sessions/${sessionId}`) throw new Error(`Unexpected request: ${route}`);
      return new Response(null, { status: 204 });
    }
    if (route === `/plugins/setup-sessions/${sessionId}`) return Response.json(installationFailed ? { ...state, pluginId: storeId, status: "error", error: "Configuration could not be saved" } : installed ? currentState : { ...currentState, pluginId: undefined, status: "ready" });
    if (route === `/plugins/setup-sessions/${sessionId}/draft`) return Response.json({ path: "review", revision: iconChanged ? "b".repeat(64) : revision, installedRevision: updated ? "b".repeat(64) : installed && !installationFailed ? revision : undefined, plugin: { ...draftPlugin, icon: draftIcon }, files: [], errors: [] });
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
/** An entry in the menu under the plugin's name, which stays open for a look. */
const menuEntry = async (label: string) => {
  if (!document.querySelector('[role="menu"]')) await act(async () => container.querySelector<HTMLButtonElement>(".project-name")!.click());
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label);
};
const choose = async (label: string) => {
  const entry = await menuEntry(label);
  await act(async () => entry!.click());
};
/** Answers the delete confirmation, which is a dialog rather than the browser's confirm. */
const answer = async (choice: "Delete" | "Uninstall" | "Cancel") => {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).toBeTruthy();
  await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === choice)!.click());
};

describe("Plugin Builder removal controls", () => {
  it("deletes an installed workspace independently of uninstalling its plugin", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await choose("Delete plugin draft");
    await answer("Cancel");
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    await choose("Delete plugin draft");
    await answer("Delete");
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([`DELETE /plugins/setup-sessions/${sessionId}`]);
    expect(installed).toBe(true);
    expect(window.location.hash).toBe("#/plugins");
  });

  it("deletes only conversation history and keeps the installed draft open", async () => {
    hasConversation = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await choose("Delete conversation");
    await answer("Delete");
    expect(requests).toContain(`DELETE /plugins/setup-sessions/${sessionId}/conversation`);
    expect(requests).not.toContain(`DELETE /plugins/setup-sessions/${sessionId}`);
    expect((await menuEntry("Delete conversation"))?.disabled).toBe(true);
    expect(await menuEntry("Delete plugin draft")).toBeDefined();
    expect(installed).toBe(true);
    expect(window.location.hash).toBe(`#/plugins/builder/${sessionId}`);
  });

  it("toggles the installed plugin from Builder without uninstalling it", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("Turn Review on in every project").click());
    expect(requests).toContain(`PUT /plugin-store/${storeId}/every-project`);
    expect(button("Turn Review on in every project").getAttribute("aria-checked")).toBe("false");
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    expect(installed).toBe(true);
  });

  it("honors cancellation and changes the installed view back to an installable draft after uninstalling", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await choose("Uninstall plugin");
    await answer("Cancel");
    expect(requests.filter(request => request.startsWith("DELETE"))).toEqual([]);
    await choose("Uninstall plugin");
    await answer("Uninstall");
    expect(requests).toContain(`DELETE /plugin-store/${storeId}/0.1.0`);
    expect(await menuEntry("Uninstall plugin")).toBeUndefined();
    expect(await menuEntry("Delete plugin draft")).toBeDefined();
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Install plugin");
    expect(install?.disabled).toBe(false);
  });

  it("deletes an uninstalled workspace and its unsent input before returning to Plugins", async () => {
    installed = false;
    savePluginBuilderInput(sessionId, { prompt: "Unsent draft" }, localStorage);
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await choose("Delete plugin draft");
    await answer("Delete");
    expect(requests).toContain(`DELETE /plugins/setup-sessions/${sessionId}`);
    expect(readPluginBuilderInput(sessionId, localStorage).prompt).toBe("");
    expect(window.location.hash).toBe("#/plugins");
  });

  it("reloads the settings form once an update is installed", async () => {
    hasSettings = true; iconChanged = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    const reads = () => requests.filter(request => request === `GET /plugin-store/${storeId}/configuration`).length;
    expect(reads()).toBe(1);
    const update = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Update plugin")!;
    await act(async () => update.click());
    expect(reads()).toBe(2);
  });

  it("reloads the settings form on Refresh only when the installed package changed", async () => {
    hasSettings = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    const reads = () => requests.filter(request => request === `GET /plugin-store/${storeId}/configuration`).length;
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh plugin preview"]')!;
    await act(async () => refresh.click());
    expect(reads()).toBe(1);
    updated = true;
    await act(async () => refresh.click());
    expect(reads()).toBe(2);
  });

  it("refreshes after a partial installation failure so uninstall and retry stay available", async () => {
    installed = false;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Install plugin")!;
    await act(async () => install.click());
    expect(await menuEntry("Uninstall plugin")).toBeDefined();
    expect(await menuEntry("Delete plugin draft")).toBeDefined();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Configuration could not be saved");
    const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Update plugin");
    expect(retry?.disabled).toBe(false);
  });
});


describe("Plugin Builder layout", () => {
  it("starts as one prompt with ways to begin, and keeps the chat beside the plugin once there is a draft", async () => {
    hasDraft = false;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector(".project-name")?.textContent).toBe("New plugin");
    expect(container.querySelector(".dock")).toBeNull();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".home-starts button")].find(item => item.textContent === "Skill")!.click());
    expect(readPluginBuilderInput(sessionId, localStorage).prompt).toBe("Make a Skill that teaches the agent to ");
    await act(async () => root.unmount());
    root = createRoot(container);
    hasDraft = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector(".home-starts")).toBeNull();
    expect([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(["Chat", "Overview", "Files"]);
  });

  it("says the draft is being written while the assistant works, and reads files only with Files open", async () => {
    hasDraft = false; working = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector(".dock-area-center")?.textContent).toContain("The assistant is writing the draft…");
    expect(requests.some(request => request.includes("/file"))).toBe(false);
  });

  it("keeps a chat dragged narrower than the default after a reload", async () => {
    localStorage.setItem("ohmygame-agent-width", "240");
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector<HTMLElement>(".dock")?.style.gridTemplateColumns).toContain("240px");
  });

  it("shows one Settings heading once installed", async () => {
    hasSettings = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect([...container.querySelectorAll(".plugin-builder-overview h2")].filter(heading => heading.textContent === "Settings")).toHaveLength(1);
  });

  it("keeps its panels in place", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector(".dock-tab-close")).toBeNull();
    expect(container.querySelector('.dock-tab[draggable="true"]')).toBeNull();
    expect(container.querySelector(".dock-resizer")).not.toBeNull();
  });

  it("says in the top bar when the draft has changes that are not installed", async () => {
    iconChanged = true;
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    expect(container.querySelector(".project-status")?.textContent).toBe("Checks passed · Changes not installed");
  });

  it("lists the workspaces in the rail, the open one marked, and offers a new plugin", async () => {
    sessions = [
      { id: sessionId, title: "Review", status: "installed", pluginId: storeId, createdAt: 0, updatedAt: 2 },
      { id: "other", title: "Older", status: "ready", createdAt: 0, updatedAt: 1 },
    ];
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    const items = [...container.querySelectorAll<HTMLAnchorElement>(".plugin-builder-rail-item")];
    expect(items.map(item => item.getAttribute("aria-label"))).toEqual(["Review", "Older"]);
    expect(items[0]?.getAttribute("aria-current")).toBe("page");
    expect(items[1]?.getAttribute("href")).toBe("#/plugins/builder/other");
  });

  it("opens a workspace nothing was said in for a new plugin, and only then makes one", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("New plugin").click());
    expect(requests).toContain("POST /plugins/setup-sessions");
    expect(window.location.hash).toBe("#/plugins/builder/created");
    requests = [];
    sessions = [{ id: "blank", title: "New plugin", status: "idle", createdAt: 0, updatedAt: 0 }];
    await act(async () => button("New plugin").click());
    expect(requests).not.toContain("POST /plugins/setup-sessions");
    expect(window.location.hash).toBe("#/plugins/builder/blank");
  });
});

describe("Plugin Builder icons", () => {
  const input = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const modalButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent === text)!;
  async function fill(element: HTMLInputElement, value: string) {
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
  }
  it("translates picker labels and validation notices into Chinese", async () => {
    await i18next.changeLanguage("zh-CN");
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("更改插件图标").click());
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe("插件图标");
    await act(async () => {
      Object.defineProperty(input("插件图标图片"), "files", { value: [new File(["image"], "icon.gif")] });
      input("插件图标图片").dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("请选择不超过 1 MB 的 PNG、WebP 或 SVG 图片");
  });
  it("saves a path in the package and makes the changed draft updateable", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("Change plugin icon").click());
    await act(async () => modalButton("Package image").click());
    await fill(input("Plugin icon path"), "./assets/logo.svg");
    await act(async () => modalButton("Save icon").click());
    expect(savedIcon).toEqual({ revision, icon: { type: "asset", path: "./assets/logo.svg" } });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === "Update plugin")?.disabled).toBe(false);
    expect(requests.filter(request => request === `GET /plugins/setup-sessions/${sessionId}/draft`)).toHaveLength(1);
  });
  it("validates package paths and restores the default icon", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("Change plugin icon").click());
    await act(async () => modalButton("Package image").click());
    await fill(input("Plugin icon path"), "https://example.com/logo.png");
    expect(modalButton("Save icon").disabled).toBe(true);
    await fill(input("Plugin icon path"), "./assets/logo.svg");
    expect(modalButton("Save icon").disabled).toBe(false);
    await act(async () => modalButton("Use default").click());
    expect(savedIcon).toEqual({ revision, icon: null });
  });
  it("uploads a chosen image", async () => {
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:icon-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    await act(async () => button("Change plugin icon").click());
    expect(modalButton("Choose file")).not.toBeNull();
    expect(document.querySelector(".plugin-file-picker-name")?.textContent).toBe("No file selected");
    const file = new File(["test-image"], "logo.svg", { type: "image/svg+xml" });
    await act(async () => { Object.defineProperty(input("Plugin icon image"), "files", { value: [file] }); input("Plugin icon image").dispatchEvent(new Event("change", { bubbles: true })); });
    expect(document.querySelector(".plugin-file-picker-name")?.textContent).toBe("logo.svg");
    expect(createUrl).toHaveBeenCalledWith(file);
    await act(async () => { modalButton("Save icon").click(); await vi.waitFor(() => expect(savedIcon).toBeDefined()); });
    expect(savedIcon).toEqual({ revision, image: { mediaType: "image/svg+xml", data: btoa("test-image") } });
    expect(log.mock.calls.flat().join(" ")).not.toContain("controlled input");
  });

  it("closes on Escape and returns focus to the edit button", async () => {
    await act(async () => root.render(<PluginBuilder sessionId={sessionId} onNavigate={() => {}} />));
    button("Change plugin icon").focus();
    await act(async () => button("Change plugin icon").click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Change plugin icon"));
  });
});
