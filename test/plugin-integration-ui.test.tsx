// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExternalProjectPreview,
  PluginIntegrationPanel,
  usePluginIntegrationGate,
} from "../src/renderer/plugin-integration.js";
import type { PluginIntegrationState } from "../src/shared/plugin-integration.js";
import type { ProjectState } from "../src/shared/contracts.js";
import { ProjectCreateDialog } from "../src/renderer/project-create-dialog.js";
import { ProjectPromptCreator } from "../src/renderer/project-prompt-creator.js";

const project: ProjectState = {
  id: "native",
  type: "general",
  name: "Native",
  updatedAt: "2026-10-16T00:00:00Z",
  workspacePath: "/tmp/native",
  integration: { pluginId: "fixture", preview: "external" },
  preview: { status: "waiting" },
};
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let state: PluginIntegrationState;
let actions: Array<{ action: string; projectId?: string }>;
let projectRequests: Array<{ method?: string; url: string }>;
let projectName: string;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = {
    pluginId: "fixture",
    action: "status",
    running: false,
    result: { connection: { status: "needs-setup" }, project: null },
  };
  actions = [];
  projectRequests = [];
  projectName = project.name;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init: RequestInit = {}) => {
      if (String(url).endsWith("/plugins/fixture"))
        return Response.json({
          id: "fixture",
          displayName: "TapTap Maker",
          icon: { type: "preset", id: "gamepad" },
        });
      if (String(url).includes("/projects/")) {
        projectRequests.push({ method: init.method, url: String(url) });
        if (init.method === "PATCH")
          projectName = JSON.parse(String(init.body)).name;
        if (!init.method || init.method === "PATCH")
          return Response.json({ ...project, name: projectName });
        const { integration: _integration, ...plain } = project;
        return Response.json(init.method === "PUT" ? project : plain);
      }
      if (init.method === "POST") {
        const input = JSON.parse(String(init.body));
        actions.push(input);
        state = {
          ...state,
          action: input.action,
          running: false,
          error: undefined,
        };
        if (input.action === "prepare")
          state.result = {
            ...state.result,
            connection: { status: "needs-auth" },
          };
        if (input.action === "connect")
          state.result = { ...state.result, connection: { status: "ready" } };
        if (input.action === "projects")
          state.result = {
            ...state.result,
            projects: [
              { id: "a", name: "My game" },
              { id: "b", name: "Another game" },
            ],
          };
        if (input.action === "bind")
          state.result = { ...state.result, project: { id: input.projectId } };
        if (input.action === "create")
          state.result = { ...state.result, project: { id: "created" } };
        if (input.action === "preview-status")
          state.result = { ...state.result, preview: { status: "stopped" } };
        if (input.action === "preview-start")
          state.result = { ...state.result, preview: { status: "running" } };
        if (input.action === "preview-stop")
          state.result = { ...state.result, preview: { status: "stopped" } };
      }
      return Response.json(state);
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  )!;
  expect(button, text).toBeDefined();
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
}
async function fillName(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("plugin connection UI", () => {
  it("restores the opening button's focus when the project window closes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ plugins: [], skills: [] })),
    );
    function Creator() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>New project</button>
          {open ? (
            <ProjectCreateDialog
              fixedType="general"
              onClose={() => setOpen(false)}
              onCreated={() => setOpen(false)}
            />
          ) : null}
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    const opener = container.querySelector("button")!;
    opener.focus();
    await click("New project");
    expect(document.activeElement).toBe(container.querySelector("input"));
    await click("Cancel");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("opens a ready bound project without reading dialog metadata", async () => {
    state.result = {
      connection: { status: "ready" },
      project: { id: "bound" },
    };
    const fetchIntegration = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init?: RequestInit) => {
        if (String(url).endsWith("/plugins/fixture"))
          throw new Error("Plugin details unavailable");
        return fetchIntegration(url, init);
      }),
    );
    const opened = vi.fn(),
      failed = vi.fn();
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate
                .ensure(project, "fixture", { canCreate: true })
                .then(opened, failed)
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    expect(opened).toHaveBeenCalledWith(project);
    expect(failed).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("creates in a branded dialog while keeping the original description mounted", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const opened = vi.fn();
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <textarea defaultValue="Make a forest game" />
          <button
            onClick={() =>
              void gate
                .ensure(project, "fixture", { canCreate: true })
                .then((ready) => {
                  if (ready) opened(ready);
                })
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector("textarea")?.value).toBe(
      "Make a forest game",
    );
    expect(
      container.querySelector(
        '[aria-label="Create a project with TapTap Maker"]',
      ),
    ).not.toBeNull();
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe(
      "New project",
    );
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("Account connected");
    expect(opened).not.toHaveBeenCalled();
    await fillName("Pixel garden");
    await click("Create project");
    expect(actions).toEqual([{ action: "create" }]);
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Pixel garden" }),
    );
    expect(
      container.querySelector(
        '[aria-label="Create a project with TapTap Maker"]',
      ),
    ).toBeNull();
  });
  it("preserves the real home composer on cancel and continues with its description after creation", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const fetchIntegration = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit = {}) => {
        const route = new URL(String(url), "http://localhost").pathname;
        if (route.endsWith("/composer/capabilities"))
          return Response.json({
            plugins: [
              {
                id: "fixture",
                name: "fixture",
                displayName: "TapTap Maker",
                marketplaceId: "test",
                integration: { entry: "./adapter.mjs", createProject: true },
                projectTypes: ["general"],
              },
            ],
            skills: [],
          });
        if (route.endsWith("/models")) return Response.json({ models: [] });
        if (route.endsWith("/projects") && init.method === "POST")
          return Response.json(project);
        if (route.endsWith("/conversations") && init.method === "POST")
          return Response.json({ id: "chat" });
        return fetchIntegration(url, init);
      }),
    );
    const opened = vi.fn();
    await act(async () =>
      root.render(
        <ProjectPromptCreator draftKey="test"
          projectType="general"
          placeholder="Describe your game"
          onCreate={opened}
        />,
      ),
    );
    const textarea = container.querySelector("textarea")!;
    async function fillPrompt(value: string) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(textarea, value);
        textarea.setSelectionRange(value.length, value.length);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await fillPrompt("@");
    const option = [
      ...container.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((element) => element.textContent?.includes("TapTap Maker"))!;
    await act(async () => option.click());
    await fillPrompt("Make a forest adventure");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    expect(container.querySelector("textarea")).toBe(textarea);
    expect(textarea.value).toBe("Make a forest adventure");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(textarea.closest("[inert]")).not.toBeNull();
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(textarea));
    expect(textarea.value).toBe("Make a forest adventure");
    expect(textarea.closest("[inert]")).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[type="submit"]')!
        .click(),
    );
    await click("Create project");
    expect(opened).toHaveBeenCalledOnce();
    expect(opened.mock.calls[0]?.[2]).toContain("Make a forest adventure");
  });
  it("keeps new-project initialization inside the explicit creation window", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const fetchIntegration = fetch;
    const create = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit = {}) => {
        const route = new URL(String(url), "http://localhost").pathname;
        if (route.endsWith("/composer/capabilities"))
          return Response.json({
            plugins: [
              {
                id: "fixture",
                name: "fixture",
                displayName: "Maker",
                marketplaceId: "test",
                projectTypes: ["general"],
                integration: { entry: "./adapter.mjs", createProject: true },
              },
            ],
            skills: [],
          });
        if (route.endsWith("/projects") && init.method === "POST") {
          create(JSON.parse(String(init.body)));
          return Response.json(project);
        }
        return fetchIntegration(url, init);
      }),
    );
    const opened = vi.fn();
    await act(async () =>
      root.render(
        <ProjectCreateDialog
          initialType="general"
          onClose={() => {}}
          onCreated={opened}
        />,
      ),
    );
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "fixture";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: "general", pluginId: "fixture" }),
    );
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="dialog"] h2')).toHaveLength(1);
    expect(opened).not.toHaveBeenCalled();
    await click("Create project");
    expect(opened).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(projectRequests.some((request) => request.method === "PATCH")).toBe(
      false,
    );
  });
  it("connects an existing Maker project from the creation dialog", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const opened = vi.fn();
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate
                .ensure(project, "fixture", { canCreate: true })
                .then(opened)
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    await click("Existing project");
    await click("Load projects");
    await act(async () => {
      const select = container.querySelector("select")!;
      select.value = "b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Connect and start");
    expect(actions).toEqual([
      { action: "projects" },
      { action: "bind", projectId: "b" },
    ]);
    expect(opened).toHaveBeenCalledOnce();
  });
  it("keeps an entered name after a creation error and retries the same local project", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const fetchIntegration = fetch;
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit = {}) => {
        if (
          init.method === "POST" &&
          JSON.parse(String(init.body)).action === "create" &&
          fail
        ) {
          state = {
            ...state,
            action: "create",
            error: "Checkout failed; resume the existing project",
          };
          return Response.json(state);
        }
        return fetchIntegration(url, init);
      }),
    );
    const opened = vi.fn();
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate
                .ensure(project, "fixture", { canCreate: true })
                .then(opened)
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    await fillName("Fox forest");
    await click("Create project");
    expect(container.querySelector("input")?.value).toBe("Fox forest");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "resume",
    );
    expect(opened).not.toHaveBeenCalled();
    fail = false;
    await click("Create project");
    expect(opened).toHaveBeenCalledOnce();
    expect(
      projectRequests.every((request) =>
        request.url.includes("/projects/native"),
      ),
    ).toBe(true);
  });
  it("requires confirmation when the creation entry reopens an existing bound workspace", async () => {
    const { integration: _integration, ...existing } = project;
    state = {
      ...state,
      action: "bind",
      result: { connection: { status: "ready" }, project: { id: "bound" } },
    };
    const fetchIntegration = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit = {}) => {
        if (String(url).endsWith("/projects/native") && !init.method)
          return Response.json(existing);
        return fetchIntegration(url, init);
      }),
    );
    const opened = vi.fn();
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate
                .ensure(existing, "fixture", { canCreate: true })
                .then(opened)
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(opened).not.toHaveBeenCalled();
    expect(projectRequests.some((request) => request.method === "PUT")).toBe(
      false,
    );
    await click("Continue");
    expect(opened).toHaveBeenCalledOnce();
    expect(projectRequests.some((request) => request.method === "PUT")).toBe(
      true,
    );
  });
  it("does not start remote creation when setup is cancelled during a name save", async () => {
    state.result = { connection: { status: "ready" }, project: null };
    const fetchIntegration = fetch;
    let saveName: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit = {}) => {
        if (init.method === "PATCH")
          await new Promise<void>((resolve) => {
            saveName = resolve;
          });
        return fetchIntegration(url, init);
      }),
    );
    function Creator() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate.ensure(project, "fixture", { canCreate: true })
            }
          >
            Create game
          </button>
        </>
      );
    }
    await act(async () => root.render(<Creator />));
    await click("Create game");
    await fillName("Pixel garden");
    await click("Create project");
    expect(saveName).toBeDefined();
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh status"]',
      )!.disabled,
    ).toBe(true);
    expect(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Reconnect",
      )!.disabled,
    ).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Cancel"]')!
        .click(),
    );
    await act(async () => saveName!());
    expect(actions).toEqual([]);
    expect(
      container.querySelector(
        '[aria-label="Create a project with TapTap Maker"]',
      ),
    ).toBeNull();
  });
  it("requires explicit environment, login and project selection before continuing", async () => {
    const ready = vi.fn();
    await act(async () =>
      root.render(
        <PluginIntegrationPanel
          pluginId="fixture"
          projectId="native"
          onReady={ready}
        />,
      ),
    );
    await click("Prepare environment");
    await click("Connect account");
    await click("Load projects");
    const select = container.querySelector("select")!;
    expect(select.value).toBe("");
    expect(
      [...container.querySelectorAll("button")].find(
        (element) => element.textContent === "Connect this directory",
      )?.disabled,
    ).toBe(true);
    await act(async () => {
      select.value = "b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Connect this directory");
    await click("Continue");
    expect(actions.find((item) => item.action === "bind")).toEqual({
      action: "bind",
      projectId: "b",
    });
    expect(ready).toHaveBeenCalledOnce();
  });
  it("preserves a pending prompt when connection is cancelled, and reuses a ready binding", async () => {
    function Composer() {
      const gate = usePluginIntegrationGate();
      const [prompt, setPrompt] = useState("Make a game");
      return (
        <>
          {gate.dialog}
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
          <button
            onClick={() =>
              void gate.ensure(project).then((ready) => {
                if (ready) setPrompt("");
              })
            }
          >
            Send
          </button>
        </>
      );
    }
    await act(async () => root.render(<Composer />));
    await click("Send");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="dialog"] h2')).toHaveLength(1);
    expect(
      container.querySelector(".plugin-integration-footer button")?.textContent,
    ).toBe("Continue");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
        .click(),
    );
    expect(container.querySelector("textarea")!.value).toBe("Make a game");
    state.result = {
      connection: { status: "ready" },
      project: { id: "existing" },
    };
    await click("Send");
    expect(container.querySelector("textarea")!.value).toBe("");
    expect(actions.some((item) => item.action === "bind")).toBe(false);
  });
  it("shows an in-flight task immediately and lets the panel alone poll before continuing", async () => {
    vi.useFakeTimers();
    state = {
      ...state,
      action: "bind",
      running: true,
      message: "Connecting the selected project…",
      result: { connection: { status: "ready" }, project: { id: "a" } },
    };
    const send = vi.fn();
    function Composer() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate.ensure(project).then((ready) => {
                if (ready) send();
              })
            }
          >
            Send
          </button>
        </>
      );
    }
    await act(async () => root.render(<Composer />));
    await click("Send");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("Connecting the selected project…");
    const proceed = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Continue",
    )!;
    expect(proceed.disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(fetch).toHaveBeenCalledTimes(2);
    state = { ...state, running: false, message: undefined };
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(fetch).toHaveBeenCalledTimes(3);
    await click("Continue");
    expect(send).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fetch).toHaveBeenCalledTimes(3);
    state = { ...state, action: "status", running: true };
    await click("Send");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(send).toHaveBeenCalledOnce();
    state = { ...state, running: false };
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(actions).toEqual([]);
  });
  it("uses native controls without an iframe and polls only while mounted", async () => {
    state.result = { connection: { status: "ready" }, project: { id: "a" } };
    await act(async () =>
      root.render(<ExternalProjectPreview project={project} />),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("native window");
    await click("Start preview");
    await click("Stop");
    expect(actions.map((item) => item.action)).toEqual([
      "preview-status",
      "preview-start",
      "preview-stop",
    ]);
    await act(async () => root.render(null));
    expect(container.childElementCount).toBe(0);
  });
  it("runs the adapter on a timer only while the native preview is running", async () => {
    vi.useFakeTimers();
    state.result = {
      connection: { status: "ready" },
      project: { id: "a" },
      preview: { status: "stopped" },
    };
    await act(async () =>
      root.render(<ExternalProjectPreview project={project} />),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(actions).toEqual([]);
    // An agent's project_preview start appears through the retained host state.
    state = {
      ...state,
      action: "preview-start",
      result: { ...state.result, preview: { status: "running" } },
    };
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(container.textContent).toContain("Preview running");
    expect(actions).toEqual([]);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(actions.map((item) => item.action)).toEqual(["preview-status"]);
  });
  it("asks before switching an existing project to an integration", async () => {
    const { integration: _integration, ...existing } = project;
    state.result = {
      connection: { status: "ready" },
      project: { id: "bound" },
    };
    const sent = vi.fn();
    function Composer() {
      const gate = usePluginIntegrationGate();
      return (
        <>
          {gate.dialog}
          <button
            onClick={() =>
              void gate.ensure(existing, "fixture").then((ready) => {
                if (ready) sent(ready);
              })
            }
          >
            Send
          </button>
        </>
      );
    }
    await act(async () => root.render(<Composer />));
    await click("Send");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain(
      "Web preview and Community publishing turn off",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
        .click(),
    );
    expect(projectRequests).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
    await click("Send");
    await click("Continue");
    expect(projectRequests).toEqual([
      { method: "PUT", url: "/api/projects/native/integration" },
    ]);
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ integration: project.integration }),
    );
  });
  it("offers disconnecting only while the connection is unusable", async () => {
    state.result = { connection: { status: "ready" }, project: { id: "a" } };
    const updated = vi.fn();
    await act(async () =>
      root.render(
        <ExternalProjectPreview project={project} onProjectUpdated={updated} />,
      ),
    );
    expect(container.textContent).not.toContain("Disconnect plugin");
    await act(async () => root.unmount());
    root = createRoot(container);
    state.result = {
      connection: { status: "needs-auth" },
      project: { id: "a" },
    };
    await act(async () =>
      root.render(
        <ExternalProjectPreview project={project} onProjectUpdated={updated} />,
      ),
    );
    await click("Disconnect plugin");
    expect(projectRequests).toEqual([]);
    await click("Disconnect");
    expect(projectRequests).toEqual([
      { method: "DELETE", url: "/api/projects/native/integration" },
    ]);
    expect(updated).toHaveBeenCalledWith(
      expect.not.objectContaining({ integration: expect.anything() }),
    );
  });
});
