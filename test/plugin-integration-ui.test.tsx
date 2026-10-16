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
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state = {
    pluginId: "fixture",
    action: "status",
    running: false,
    result: { connection: { status: "needs-setup" }, project: null },
  };
  actions = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit = {}) => {
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

describe("plugin connection UI", () => {
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
});
