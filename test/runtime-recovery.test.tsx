// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRuntimeState } from "../src/shared/desktop-runtime.js";
import type { ProjectState, RuntimeEvent } from "../src/shared/contracts.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installDesktop() {
  const service = {
    state: vi.fn(),
    restart: vi.fn(),
    onState: vi.fn((_listener: (state: DesktopRuntimeState) => void) => () => {}),
  };
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: {
      platform: "darwin",
      runtime: { daemonUrl: "http://127.0.0.1:1000", token: "old-token" },
      runtimeService: service,
    },
  });
  return service;
}

const ready = (generation: number): DesktopRuntimeState => ({
  status: "ready",
  generation,
  recovered: generation > 1,
  runtime: {
    url: `http://127.0.0.1:${1000 + generation}`,
    token: `token-${generation}`,
  },
});

function installProjectRuntime(type: ProjectState["type"] = "general") {
  const posts: string[] = [];
  const previews: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const route = new URL(url).pathname;
    const projectId = route.split("/")[2] ?? "project";
    const project = { id: projectId, name: "Test", type, webPreviewEnabled: false,
      workspacePath: "/tmp/project", updatedAt: new Date(0).toISOString(), preview: { status: "stopped" } };
    const conversation = { id: "conversation", projectId, name: "Chat", createdAt: project.updatedAt, updatedAt: project.updatedAt };
    if (route.endsWith("/events")) return new Response(new ReadableStream({
      start(controller) {
        init.signal!.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
    if (route.endsWith("/turns") && init.method === "POST") {
      posts.push(String(init.body));
      return Response.json({ turnId: "turn" }, { status: 202 });
    }
    if (route.includes("/preview/leases/") && init.method === "PUT") {
      const input = JSON.parse(String(init.body));
      if (input.automatic && !input.paused) previews.push(projectId);
      return Response.json({});
    }
    if (route.endsWith("/preview") && init.method === "POST") {
      previews.push(projectId);
      return Response.json({ url: "http://127.0.0.1:4000" });
    }
    return Response.json(route === `/projects/${projectId}` ? project
      : route.endsWith("/conversations") ? [conversation]
      : route.endsWith("/conversations/conversation") ? {
        conversation, cursor: 0, agent: { status: "idle" }, settings: {}, plan: { mode: "normal" }, turns: [], pendingPrompts: [],
      }
      : route.endsWith("/models") || route.endsWith("/catalog") ? { models: [], providers: [] }
      : route.includes("capabilities") ? { plugins: [], skills: [] } : []);
  }));
  return { posts, previews };
}

describe("renderer service recovery", () => {
  it.each([1, 2])(
    "sends initial messages from generation %s only after the appropriate user action",
    async (promptGeneration) => {
      installDesktop();
      const { updateRuntimeConnection } =
        await import("../src/renderer/runtime-connection.js");
      const { ProjectShell } = await import("../src/renderer/project-shell.js");
      const { AuthProvider } = await import("../src/renderer/auth.js");
      updateRuntimeConnection(ready(2));
      const { posts } = installProjectRuntime();
      const handled = vi.fn();
      await act(async () =>
        root.render(
          <AuthProvider>
            <ProjectShell
              projectId="project"
              conversationId="conversation"
              initialPrompt={{
                generation: promptGeneration,
                prompt: "Build my game",
                mentions: [],
                images: [],
                mode: "normal",
              }}
              onInitialPromptHandled={handled}
              onOpenConversation={() => {}}
              onHome={() => {}}
            />
          </AuthProvider>,
        ),
      );
      if (promptGeneration === 1) {
        expect(posts).toEqual([]);
        expect(container.textContent).toContain("Build my game");
        const button = container.querySelector<HTMLButtonElement>(
          ".paused-initial-prompt button",
        )!;
        expect(button.disabled).toBe(false);
        await act(async () => button.click());
      }
      expect(posts).toHaveLength(1);
      expect(JSON.parse(posts[0])).toMatchObject({ prompt: "Build my game" });
      expect(handled).toHaveBeenCalledTimes(1);
    },
  );

  it("pauses the current preview on recovery while allowing a later project to start normally", async () => {
    installDesktop();
    const { updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");
    const { ProjectShell } = await import("../src/renderer/project-shell.js");
    const { AuthProvider } = await import("../src/renderer/auth.js");
    const { previews } = installProjectRuntime("web-game");
    const renderProject = (projectId: string) => root.render(<AuthProvider>
      <ProjectShell key={projectId} projectId={projectId} conversationId="conversation" onOpenConversation={() => {}} onHome={() => {}} />
    </AuthProvider>);
    updateRuntimeConnection(ready(1));
    await act(async () => renderProject("old-project"));
    expect(previews).toEqual(["old-project"]);
    const input = container.querySelector("textarea");
    await act(async () => updateRuntimeConnection({ status: "recovering", generation: 2, recovered: true }));
    await act(async () => updateRuntimeConnection(ready(2)));
    expect(previews).toEqual(["old-project"]);
    expect(container.querySelector("textarea")).toBe(input);
    expect(container.textContent).toContain("Preview is paused after service recovery");
    await act(async () => renderProject("new-project"));
    expect(previews).toEqual(["old-project", "new-project"]);
    expect(container.textContent).not.toContain("Preview is paused after service recovery");
  });

  it("loads the home project list once after the initial desktop handshake", async () => {
    const service = installDesktop();
    service.state.mockResolvedValue(ready(1));
    const { initializeRuntimeConnection } = await import("../src/renderer/runtime-connection.js");
    const { Home } = await import("../src/renderer/home.js");
    const { AuthProvider } = await import("../src/renderer/auth.js");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(new URL(url).pathname);
      return Response.json(url.endsWith("/models") || url.endsWith("/catalog") ? { models: [], providers: [] }
        : url.includes("capabilities") ? { plugins: [], skills: [] } : []);
    }));
    await initializeRuntimeConnection();
    await act(async () => root.render(<AuthProvider><Home onNavigate={() => {}} onCreate={() => {}} onOpen={() => {}} /></AuthProvider>));
    expect(requests.filter((route) => route === "/projects")).toHaveLength(1);
  });

  it("keeps a newer service event when the initial IPC state reply arrives late", async () => {
    const service = installDesktop();
    service.state.mockResolvedValue(ready(1));
    service.onState.mockImplementation((listener: (state: DesktopRuntimeState) => void) => {
      listener(ready(2));
      return () => {};
    });
    const { initializeRuntimeConnection, runtimeConnection } = await import("../src/renderer/runtime-connection.js");
    await initializeRuntimeConnection();
    expect(runtimeConnection()).toEqual(ready(2));
  });

  it("refreshes reads only when a service generation becomes ready and retains editable views", async () => {
    installDesktop();
    const { updateRuntimeConnection, useReadyRuntimeGeneration } =
      await import("../src/renderer/runtime-connection.js");
    updateRuntimeConnection(ready(1));
    const read = vi.fn();
    function View() {
      const generation = useReadyRuntimeGeneration();
      useEffect(() => {
        read(generation);
      }, [generation]);
      return <textarea defaultValue="Draft" />;
    }
    await act(async () => root.render(<View />));
    const input = container.querySelector("textarea")!;
    input.value = "Still editing";
    await act(async () =>
      updateRuntimeConnection({
        status: "recovering",
        generation: 2,
        recovered: true,
      }),
    );
    expect(read.mock.calls).toEqual([[1]]);
    await act(async () => updateRuntimeConnection(ready(2)));
    expect(read.mock.calls).toEqual([[1], [2]]);
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Still editing");
  });

  it("keeps the home view mounted across recovery", async () => {
    installDesktop();
    const { updateRuntimeConnection } =
      await import("../src/renderer/runtime-connection.js");
    updateRuntimeConnection(ready(1));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("/models") || url.endsWith("/catalog")
            ? { models: [], providers: [] }
            : url.includes("capabilities")
              ? { plugins: [], skills: [] }
              : [],
        ),
      ),
    );
    const { App } = await import("../src/renderer/app.js");
    const { AuthProvider } = await import("../src/renderer/auth.js");
    window.history.replaceState(null, "", "#/");
    await act(async () =>
      root.render(
        <AuthProvider>
          <App />
        </AuthProvider>,
      ),
    );
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(input, "My unsent game idea");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      updateRuntimeConnection({
        status: "recovering",
        generation: 2,
        recovered: true,
      }),
    );
    await act(async () => updateRuntimeConnection(ready(2)));
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("My unsent game idea");
  });

  it("uses new credentials and rejects mutations while offline without replaying them", async () => {
    installDesktop();
    const { updateRuntimeConnection } =
      await import("../src/renderer/runtime-connection.js");
    const { request } = await import("../src/renderer/api.js");
    const fetchMock = vi.fn(async () => Response.json({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    updateRuntimeConnection(ready(1));
    await request("/health");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:1001/health",
      expect.objectContaining({ headers: { authorization: "Bearer token-1" } }),
    );
    updateRuntimeConnection({
      status: "recovering",
      generation: 2,
      recovered: true,
    });
    await expect(
      request("/projects/project/conversations/conversation/prompt", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("background service is unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    updateRuntimeConnection(ready(2));
    await request("/health");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:1002/health",
      expect.objectContaining({ headers: { authorization: "Bearer token-2" } }),
    );
    await request("/projects", { method: "POST", body: "{}" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:1002/projects",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes settings after recovery without replacing an unsaved form", async () => {
    installDesktop();
    const { updateRuntimeConnection } =
      await import("../src/renderer/runtime-connection.js");
    const { NetworkSettingsPanel } =
      await import("../src/renderer/network-settings.js");
    updateRuntimeConnection(ready(1));
    const fetchMock = vi.fn(async () =>
      Response.json({
        settings: {
          mode: "manual",
          proxyUrl: "http://127.0.0.1:7890",
          noProxy: "",
        },
        active: { source: "direct", noProxy: "" },
        detected: { source: "direct", noProxy: "" },
        requiresRestart: false,
        systemProxyAvailable: false,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<NetworkSettingsPanel />));
    const input =
      container.querySelector<HTMLInputElement>('input[type="url"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "http://127.0.0.1:9999");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      updateRuntimeConnection({
        status: "recovering",
        generation: 2,
        recovered: true,
      }),
    );
    await act(async () => updateRuntimeConnection(ready(2)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input[type="url"]')).toBe(input);
    expect(input.value).toBe("http://127.0.0.1:9999");
  });

  it.each([false, true])("loads plugin details once and preserves loaded drafts across recovery (loaded: %s)", async (loaded) => {
    installDesktop();
    const { updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");
    const { PluginsSettings } = await import("../src/renderer/plugins.js");
    updateRuntimeConnection(ready(1));
    let detailReads = 0;
    let catalogReads = 0;
    const configuration = {
      fields: { endpoint: { type: "string", label: "Endpoint" } }, values: { endpoint: "Saved endpoint" }, configuredSecrets: [], missing: [],
    };
    const plugin = {
      id: "test", name: "test", displayName: "Test plugin", description: "Test", marketplace: { id: "test", displayName: "Test" },
      source: { type: "builtIn" }, installed: true, enabled: true, skills: [], connections: [], configuration: configuration.fields,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const route = new URL(url).pathname;
      if (route === "/plugins/test") {
        detailReads++;
        if (!loaded && detailReads === 1) return Response.json({ error: "Detail failed" }, { status: 500 });
        return Response.json(plugin);
      }
      if (route === "/plugins") { catalogReads++; return Response.json({ plugins: [], errors: [] }); }
      if (route === "/plugins/test/configuration") return Response.json(configuration);
      return Response.json({ status: "ok" });
    }));
    await act(async () => root.render(<PluginsSettings pluginId="test" onPluginChange={() => {}} onTryPlugin={async () => {}} />));
    expect(detailReads).toBe(1);
    const input = container.querySelector<HTMLInputElement>(".plugin-configuration input");
    if (loaded) await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Unsaved endpoint");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => updateRuntimeConnection({ status: "recovering", generation: 2, recovered: true }));
    await act(async () => updateRuntimeConnection(ready(2)));
    expect(catalogReads).toBe(2);
    expect(detailReads).toBe(loaded ? 1 : 2);
    if (loaded) {
      expect(container.querySelector(".plugin-configuration input")).toBe(input);
      expect(input!.value).toBe("Unsaved endpoint");
      await act(async () => container.querySelector(".plugin-configuration form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(detailReads).toBe(2); // An explicit configuration save still refreshes the details.
    } else expect(container.textContent).toContain("Test plugin");
  });

  it("resets an event cursor across daemon generations and receives low-numbered new events", async () => {
    installDesktop();
    const { updateRuntimeConnection } =
      await import("../src/renderer/runtime-connection.js");
    const { subscribeToProject } = await import("../src/renderer/api.js");
    updateRuntimeConnection(ready(1));
    const requests: string[] = [];
    const received: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push(url);
        const event: RuntimeEvent = {
          id: url.includes(":1001/") ? 51 : 1,
          projectId: "project",
          type: "preview.updated",
          data: { preview: { status: "stopped" } },
          timestamp: new Date().toISOString(),
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
              init.signal!.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const reset = vi.fn(async () => 0);
    const unsubscribe = subscribeToProject("project", 50, {
      onEvent: (event) => received.push(event.id),
      onOpen: () => {},
      onError: () => {},
      onReset: reset,
    });
    try {
      await vi.waitFor(() => expect(received).toEqual([51]));
      updateRuntimeConnection({
        status: "recovering",
        generation: 2,
        recovered: true,
      });
      updateRuntimeConnection(ready(2));
      await vi.waitFor(() => expect(received).toEqual([51, 1]), {
        timeout: 2000,
      });
      expect(reset).toHaveBeenCalledTimes(1);
      expect(requests[1]).toBe(
        "http://127.0.0.1:1002/projects/project/events?cursor=0",
      );
    } finally {
      unsubscribe();
    }
  });

  it("shows recovery controls without unmounting the current view or input", async () => {
    const service = installDesktop();
    const { updateRuntimeConnection } =
      await import("../src/renderer/runtime-connection.js");
    const { RuntimeNotice } = await import("../src/renderer/runtime-notice.js");
    updateRuntimeConnection(ready(1));
    await act(async () =>
      root.render(
        <>
          <RuntimeNotice />
          <textarea defaultValue="Unsent message" />
        </>,
      ),
    );
    const input = container.querySelector("textarea")!;
    await act(async () =>
      updateRuntimeConnection({
        status: "error",
        generation: 1,
        recovered: false,
        error: "Service exited",
      }),
    );
    expect(container.textContent).toContain("Restart service");
    expect(container.querySelector("textarea")).toBe(input);
    service.restart.mockImplementation(async () => {
      updateRuntimeConnection(ready(2));
      return ready(2);
    });
    await act(async () => container.querySelector("button")!.click());
    expect(service.restart).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("Unsent message");
    expect(container.querySelector(".runtime-notice")).toBeNull();
  });
});

describe("pane and preview boundaries", () => {
  it("tracks internal navigation without replacing the game and reloads or opens its current scene", async () => {
    installDesktop();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const { CodingWorkspace } = await import("../src/renderer/coding-workspace.js");
    const { updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");
    updateRuntimeConnection(ready(1));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const project: ProjectState = { id: "routes", name: "Routes", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/routes", preview: { status: "ready", url: "http://127.0.0.1:4000" } };
    const props = { project, agentBusy: false, publishing: false, workspaceRevision: 0, onPublish: async () => false, onOpenPublish: () => {}, onClosePublish: () => {}, onRestart: () => {}, onStop: async () => {} };
    await act(async () => root.render(createElement(CodingWorkspace, props)));
    const frame = container.querySelector("iframe")!;
    const client = new URL(frame.src).searchParams.get("__ohmygame_client")!;
    const moved = { ...project, preview: { ...project.preview, pages: [{ client, source: "editor" as const, path: "/scene-2?level=2#boss" }] } };
    await act(async () => root.render(createElement(CodingWorkspace, { ...props, project: moved })));
    expect(container.querySelector("iframe")).toBe(frame);
    expect(new URL(frame.src).pathname).toBe("/");
    expect(container.querySelector(".preview-location-path")?.textContent).toBe("/scene-2?level=2#boss");
    await act(async () => (container.querySelector('[aria-label="Project settings"]') as HTMLButtonElement).click());
    const browser = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Open preview in browser")!;
    await act(async () => browser.click());
    const url = new URL(String(open.mock.calls[0][0]));
    expect(`${url.pathname}?level=${url.searchParams.get("level")}${url.hash}`).toBe("/scene-2?level=2#boss");
    expect(container.querySelector(".preview-run-menu")).toBeNull();
    await act(async () => (container.querySelector('.project-settings-dialog [aria-label="Close"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="Reload preview"]') as HTMLButtonElement).click());
    expect(container.querySelector("iframe")).not.toBe(frame);
    const reloaded = new URL(container.querySelector("iframe")!.src);
    expect(reloaded.pathname).toBe("/scene-2");
    expect(reloaded.searchParams.get("level")).toBe("2");
    expect(reloaded.hash).toBe("#boss");
  });

  it("opens preview logs from Code without changing the active view", async () => {
    installDesktop();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    const { CodingWorkspace } = await import("../src/renderer/coding-workspace.js");
    const { updateRuntimeConnection } = await import("../src/renderer/runtime-connection.js");
    updateRuntimeConnection(ready(1));
    const project: ProjectState = { id: "logs", name: "Logs", type: "web-game", updatedAt: new Date(0).toISOString(), workspacePath: "/tmp/logs", preview: { status: "stopped", logs: "Preview was stopped." } };
    await act(async () => root.render(createElement(CodingWorkspace, { project, agentBusy: false, publishing: false, workspaceRevision: 0, onPublish: async () => false, onOpenPublish: () => {}, onClosePublish: () => {}, onRestart: () => {} })));
    await act(async () => (container.querySelector('.workspace-tab[title="Code"]') as HTMLButtonElement).click());
    await act(async () => (container.querySelector('[aria-label="Project settings"]') as HTMLButtonElement).click());
    const logs = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Preview logs")!;
    await act(async () => logs.click());
    expect(container.querySelector(".coding-workspace")?.getAttribute("data-active-tab")).toBe("code");
    expect(container.querySelector(".project-settings-dialog")).toBeNull();
    expect(container.querySelector(".coding-workspace > .preview-logs")?.textContent).toContain("Preview was stopped.");
    await act(async () => (container.querySelector('[aria-label="Close preview logs"]') as HTMLButtonElement).click());
    expect(container.querySelector(".preview-logs")).toBeNull();
    expect(container.querySelector(".coding-workspace")?.getAttribute("data-active-tab")).toBe("code");
  });

  it("keeps sibling input available when a pane throws and permits a retry", async () => {
    const { ErrorBoundary } = await import("../src/renderer/error-boundary.js");
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    function Pane() {
      if (broken) throw new Error("Bad preview component");
      return <span>Recovered pane</span>;
    }
    await act(async () =>
      root.render(
        <>
          <textarea defaultValue="Keep this" />
          <ErrorBoundary label="Preview">
            <Pane />
          </ErrorBoundary>
        </>,
      ),
    );
    const input = container.querySelector("textarea")!;
    expect(container.textContent).toContain("Preview could not be displayed");
    broken = false;
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Recovered pane");
    expect(container.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("Keep this");
  });

  it("shows and clears service diagnostics while retaining the preview frame", async () => {
    const originalError = console.error;
    vi.spyOn(console, "error").mockImplementation((...args) => {
      if (
        args[0] instanceof DOMException &&
        args[0].message.includes("Iframe page loading is disabled")
      )
        return;
      originalError(...args);
    });
    (
      window as unknown as {
        happyDOM: { settings: { disableIframePageLoading: boolean } };
      }
    ).happyDOM.settings.disableIframePageLoading = true;
    Object.defineProperty(window, "ohMyGameDesktop", {
      configurable: true,
      value: undefined,
    });
    const { PreviewView } = await import("../src/renderer/coding-workspace.js");
    const project = {
      id: "project",
      name: "Game",
      type: "web-game" as const,
      updatedAt: new Date(0).toISOString(),
      workspacePath: "/tmp/project",
      preview: { status: "ready" as const, url: "http://127.0.0.1:4000" },
    };
    const props = {
      project,
      url: project.preview.url,
      reload: 0,
      revision: 0,
      viewport: "fit" as const,
    };
    await act(async () => root.render(createElement(PreviewView, props)));
    const frame = container.querySelector("iframe")!;
    await act(async () => root.render(createElement(PreviewView, { ...props,
      project: { ...project, preview: { ...project.preview, diagnostic: { kind: "runtime", message: "Broken game script" } } },
    })));
    expect(container.textContent).toContain("Broken game script");
    expect(container.querySelector("iframe")).toBe(frame);
    await act(async () =>
      root.render(createElement(PreviewView, props)),
    );
    expect(container.querySelector(".preview-diagnostic")).toBeNull();
    expect(container.querySelector("iframe")).toBe(frame);
  });
});
