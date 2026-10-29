// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createProject: vi.fn(), createConversation: vi.fn() }));

vi.mock("../src/renderer/api.js", async (original) => ({
  ...await original<typeof import("../src/renderer/api.js")>(),
  createProject: mocks.createProject,
  createConversation: mocks.createConversation,
  waitForRuntime: async () => {},
  getHomeComposerCapabilities: async () => ({ plugins: [], skills: [] }),
}));
vi.mock("../src/renderer/model-selector.js", () => ({
  useAgentModels: () => ({ models: [], status: "ready" }),
  ModelSelector: () => null,
}));
vi.mock("../src/renderer/plugin-integration.js", () => ({
  referencedIntegration: () => undefined,
  usePluginIntegrationGate: () => ({ ensure: async (project: unknown) => project }),
}));
vi.mock("../src/renderer/prompt-box.js", () => ({
  PromptBox: (props: { onSubmit: () => void; value: string; disabled?: boolean }) => <button data-submit disabled={props.disabled} onClick={props.onSubmit}>{props.value}</button>,
}));

import { composerDrafts, homeDraftScope } from "../src/renderer/composer-drafts.js";
import { ProjectPromptCreator } from "../src/renderer/project-prompt-creator.js";

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("does not submit the Home prompt twice when returning during project creation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const pending: Array<(project: unknown) => void> = [];
  mocks.createProject.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  mocks.createConversation.mockImplementation(async (id: string) => ({ id: `${id}-conversation` }));
  const draftSession = composerDrafts.get(homeDraftScope("submit-remount-test"));
  draftSession.update({ prompt: "Create a racing game" });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onCreate = vi.fn();
  const page = <ProjectPromptCreator draftKey="submit-remount-test" projectType="web-game" placeholder="Describe" onCreate={onCreate} />;
  await act(async () => root.render(page));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-submit]")!.click());
  expect(mocks.createProject).toHaveBeenCalledTimes(1);
  expect(draftSession.getSnapshot().submitting).toBe(true);

  await act(async () => root.render(null));
  await act(async () => root.render(page));
  expect(draftSession.getSnapshot().submitting).toBe(true);
  expect(host.querySelector<HTMLButtonElement>("[data-submit]")!.disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>("[data-submit]")!.click());
  expect(mocks.createProject).toHaveBeenCalledTimes(1);

  await act(async () => pending[0]({ id: "project-1", type: "web-game" }));
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onCreate.mock.calls[0][2]).toBe("Create a racing game");
  expect(draftSession.getSnapshot()).toMatchObject({ prompt: "", submitting: false });

  await act(async () => root.unmount());
  host.remove();
});
