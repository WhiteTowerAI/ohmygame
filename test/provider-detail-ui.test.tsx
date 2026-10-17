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

it("keeps the provider header compact and exposes advanced connection settings", async () => {
  const onViewChange = vi.fn();
  await render(onViewChange);
  expect(
    host.querySelector(".settings-provider-detail-header small")?.textContent,
  ).toBe("Browser sign-in or API key");
  expect(host.querySelector('.settings-provider-detail-header button[aria-label="Back"]')).toBeDefined();
  expect(host.querySelector(".settings-provider-breadcrumb")).toBeNull();
  expect(host.querySelector(".settings-provider-detail-header .settings-provider-delete")).toBeDefined();
  expect(host.querySelectorAll(".settings-provider-status-dot")).toHaveLength(0);
  const connection = host.querySelector('[aria-label="Connection"]')!;
  expect(connection.textContent).toContain("Signed in with ChatGPT");
  expect(connection.querySelectorAll(".settings-provider-status-dot")).toHaveLength(0);
  expect(host.querySelector(".settings-provider-remove")).toBeNull();
  expect(button("Use API key")).toBeDefined();
  const advanced = host.querySelector<HTMLDetailsElement>(
    ".settings-provider-advanced",
  )!;
  expect(advanced.open).toBe(true);
  expect(advanced.textContent).toContain("Responses connection");

  await act(async () => host.querySelector<HTMLButtonElement>('.settings-provider-detail-header button[aria-label="Back"]')!.click());
  expect(onViewChange).toHaveBeenCalledWith({ page: "providers" });
});

it("confirms before removing the provider", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-provider-detail-header .settings-provider-delete")!.click());
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
