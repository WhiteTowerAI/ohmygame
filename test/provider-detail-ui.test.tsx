// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ProviderModelSettings,
  ProviderSummary,
} from "../src/shared/contracts.js";

const model = (id: string, visible = true) => ({
  provider: "openai",
  providerName: "OpenAI",
  id,
  name: id.toUpperCase(),
  reasoningLevels: [],
  visible,
  custom: false,
});
const api = {
  getOpenAIEndpointSettings: vi.fn(async () => ({
    baseUrl: "https://api.openai.com/v1",
  })),
  getOpenAIImageSettings: vi.fn(async () => ({
    mode: "connection",
    baseUrl: "https://api.openai.com/v1",
    configured: false,
    connectionAvailable: true,
    models: [],
  })),
  getResponsesTransport: vi.fn(async () => ({ mode: "auto" })),
  getProviderModels: vi.fn(async (): Promise<ProviderModelSettings> => ({
    models: [model("gpt-4"), model("gpt-5"), model("gpt-3.5", false)],
    defaultApi: "openai-responses",
    canAddCustomModel: false,
  })),
  listModels: vi.fn(async () => ({
    models: [],
    defaultModel: { provider: "openai", id: "gpt-5" },
    defaultReasoningLevel: "medium",
  })),
  removeProvider: vi.fn(async () => {}),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const openai: ProviderSummary = {
  id: "openai",
  name: "OpenAI",
  configured: true,
  languageConfigured: true,
  credentialType: "oauth",
  status: "connected",
  capabilities: ["language"],
  methods: [
    { type: "oauth", label: "Sign in with ChatGPT" },
    { type: "api_key", label: "OpenAI API key" },
  ],
};

async function render(onViewChange = vi.fn()) {
  await act(async () =>
    root.render(
      <ModelsSettings
        view={{ page: "provider", provider: openai }}
        onViewChange={onViewChange}
      />,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
const rows = () =>
  [...host.querySelectorAll(".provider-model-row strong")].map(
    (item) => item.textContent,
  );

it("leads with the connection status and keeps removal and advanced settings at the end", async () => {
  const onViewChange = vi.fn();
  await render(onViewChange);
  expect(
    host.querySelector(".settings-provider-detail-header small")?.textContent,
  ).toBe("Connected · ChatGPT");
  const connection = host.querySelector('[aria-label="Connection"]')!;
  expect(connection.textContent).toContain("Signed in with ChatGPT");
  expect(button("Reconnect")).toBeDefined();
  expect(button("Use API key")).toBeDefined();
  expect(
    host.querySelector(
      ".settings-provider-detail-header .settings-provider-delete",
    ),
  ).toBeNull();

  const sections = [
    ...host.querySelector(".settings-provider-detail")!.children,
  ];
  const advanced = host.querySelector<HTMLDetailsElement>(
    ".settings-provider-advanced",
  )!;
  const remove = host.querySelector('[aria-label="Remove provider"]')!;
  expect(advanced.open).toBe(false);
  expect(advanced.textContent).toContain("Responses connection");
  expect(sections.indexOf(remove)).toBe(sections.length - 1);
  expect(sections.indexOf(advanced)).toBe(sections.length - 2);

  await act(async () => button("Providers & Models")!.click());
  expect(onViewChange).toHaveBeenCalledWith({ page: "providers" });
});

it("confirms before removing the provider", async () => {
  await render();
  await act(async () => button("Remove…")!.click());
  expect(button("Remove…")).toBeUndefined();
  await act(async () => button("Delete provider")!.click());
  expect(api.removeProvider).toHaveBeenCalledWith("openai");
});

it("puts the default model first and keeps hidden models behind a toggle", async () => {
  await render();
  expect(rows()).toEqual(["GPT-5", "GPT-4"]);
  expect(
    host
      .querySelector(".provider-model-default")
      ?.closest(".provider-model-row")?.textContent,
  ).toContain("GPT-5");
  await act(async () => button("Hidden models (1)")!.click());
  expect(rows()).toEqual(["GPT-5", "GPT-4", "GPT-3.5"]);
});
