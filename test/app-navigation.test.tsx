// @vitest-environment happy-dom
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppNavigation } from "../src/renderer/app-navigation.js";
import {
  conversationHash,
  projectHash,
  projectsHash,
} from "../src/renderer/routes.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let navigation: ReturnType<typeof useAppNavigation>;

function Harness() {
  navigation = useAppNavigation();
  return (
    <button onClick={() => navigation.navigate(navigation.projectReturnTo)}>
      {navigation.projectBackLabel}
    </button>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.history.replaceState(null, "", "#/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(hash: string, state: unknown = null) {
  window.history.replaceState(state, "", hash);
  await act(async () => root.render(<Harness />));
}

async function navigate(hash: string, replace = false) {
  await act(async () => navigation.navigate(hash, { replace }));
}

async function followHash(hash: string) {
  await act(async () => {
    const changed = new Promise<void>((resolve) =>
      window.addEventListener("hashchange", () => resolve(), { once: true }),
    );
    window.location.hash = hash;
    await changed;
  });
}

async function traverseHistory(delta: number) {
  await act(async () => {
    const changed = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.go(delta);
    await changed;
  });
}

describe("project return navigation", () => {
  it("labels the return destination in Simplified Chinese", async () => {
    const previousLanguage = i18next.language;
    try {
      await i18next.changeLanguage("zh-CN");
      await mount("#/general");
      await navigate(projectHash("project"));
      expect(container.textContent).toBe("返回通用游戏");
    } finally {
      await i18next.changeLanguage(previousLanguage);
    }
  });

  it.each([
    ["#/", "Home"],
    ["#/general", "General Game"],
    ["#/web-game", "Web Game"],
    ["#/interactive-story", "Interactive Story"],
    ["#/godot", "Godot"],
    ["#/asset-canvas", "Asset Canvas"],
    ["#/library", "Library"],
    ["#/community/games", "Community"],
    ["#/settings/plugins/plugin", "Plugins"],
  ])(
    "returns a project opened from %s to its entry page",
    async (hash, label) => {
      await mount(hash);
      await navigate(projectHash("project"));
      expect(container.textContent).toBe(`Back to ${label}`);
      await act(async () => container.querySelector("button")!.click());
      expect(window.location.hash).toBe(hash);
    },
  );

  it("keeps all list filters after conversation changes, design changes, and a reload", async () => {
    const hash = projectsHash({
      projectType: "web-game",
      query: "Garden & Forest",
      sort: "name",
    });
    await mount(hash);
    await navigate(projectHash("project"));
    await navigate(conversationHash("project", "first"), true);
    await navigate(conversationHash("project", "second"));
    await navigate(conversationHash("project", "second", "design"));
    const historyLength = window.history.length;
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    expect(window.history.length).toBe(historyLength);
    expect(navigation.projectReturnTo).toBe(hash);
    await navigate(navigation.projectReturnTo);
    expect(navigation.route).toEqual({
      page: "projects",
      projectType: "web-game",
      query: "Garden & Forest",
      sort: "name",
    });
  });

  it("captures plain hash links and inherits the entry when opening another project from the canvas", async () => {
    await mount("#/asset-canvas");
    await followHash(projectHash("canvas"));
    expect(navigation.route).toEqual({ page: "project", projectId: "canvas" });
    await navigate(conversationHash("canvas", "chat"), true);
    await followHash(projectHash("game"));
    expect(navigation.route).toEqual({ page: "project", projectId: "game" });
    expect(navigation.projectReturnTo).toBe("#/asset-canvas");
  });

  it("restores each project's own entry through browser back and forward", async () => {
    await mount("#/web-game");
    await navigate(projectHash("first"));
    await navigate("#/godot");
    await navigate(projectHash("second"));
    await traverseHistory(-2);
    expect(navigation.route).toEqual({ page: "project", projectId: "first" });
    expect(navigation.projectReturnTo).toBe("#/web-game");
    await traverseHistory(2);
    expect(navigation.route).toEqual({ page: "project", projectId: "second" });
    expect(navigation.projectReturnTo).toBe("#/godot");
  });

  it("uses Projects for a direct project link instead of another site's history", async () => {
    await mount(conversationHash("project", "chat", "design"));
    expect(navigation.projectReturnTo).toBe("#/projects");
    expect(container.textContent).toBe("Back to Projects");
  });

  it.each([
    "https://example.com",
    "#/unknown",
    "#/projects/other",
    "#/playtest/project",
    "#/thumbnail/project/node",
    null,
    42,
  ])("ignores an invalid saved return target: %s", async (projectReturnTo) => {
    await mount(projectHash("project"), { projectReturnTo });
    expect(navigation.projectReturnTo).toBe("#/projects");
  });

  it("keeps the plugin's canonical address as the project entry", async () => {
    await mount("#/plugins/plugin", { settingsEntry: true });
    expect(window.location.hash).toBe("#/settings/plugins/plugin");
    expect(window.history.state.settingsEntry).toBe(true);
    await navigate(conversationHash("project", "chat", "design"));
    expect(navigation.projectReturnTo).toBe("#/settings/plugins/plugin");
  });
});
