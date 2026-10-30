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
const audioProviders: ProviderSummary[] = [
  {
    id: "volcengine-tts",
    name: "Doubao Speech",
    configured: true,
    enabled: true,
    status: "connected",
    capabilities: ["audio"],
    methods: [],
  },
  {
    id: "volcengine-seed-audio",
    name: "Doubao Seed Audio",
    configured: true,
    enabled: true,
    status: "connected",
    capabilities: ["audio"],
    methods: [],
  },
];
const api = {
  listProviders: vi.fn(async () => audioProviders),
  getVolcengineTtsSettings: vi.fn(async () => ({
    configured: true,
    defaultVoiceId: "zh_female_vv_uranus_bigtts",
  })),
  listAudioModelCatalog: vi.fn(async () => ({ models: [], providers: [] })),
  setProviderEnabled: vi.fn(async (id: string, enabled: boolean) => ({
    ...audioProviders.find((provider) => provider.id === id)!,
    enabled,
  })),
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
    canRefreshCatalog: true,
  })),
  refreshProviderModels: vi.fn(async () => ({})),
  setProviderModelVisibility: vi.fn<(...args: [string, string[], boolean]) => Promise<ProviderModelSettings>>(),
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
  vi.useRealTimers();
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

async function render(onViewChange = vi.fn(), provider = openai) {
  await act(async () =>
    root.render(
      <ModelsSettings
        view={{ page: "provider", provider }}
        onViewChange={onViewChange}
        onOpenAgents={() => {}}
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

it.each(audioProviders)("keeps $name settings and actions independent", async (provider) => {
  await render(vi.fn(), provider);
  const header = host.querySelector(".settings-provider-detail-header")!;
  const toggle = header.querySelector<HTMLInputElement>('[role="switch"]')!;
  expect(toggle.getAttribute("aria-label")).toBe(`Enable ${provider.name}`);
  expect(host.querySelector(".settings-provider-filters")).toBeNull();
  expect(host.querySelector(`#${provider.id}-api-key`)).toBeTruthy();
  if (provider.id === "volcengine-tts") expect(host.querySelector<HTMLSelectElement>("#volcengine-tts-voice-select")!.value).toBe("zh_female_vv_uranus_bigtts");
  else expect(host.querySelector("#volcengine-tts-voice-select")).toBeNull();
  await act(async () => toggle.click());
  expect(api.setProviderEnabled).toHaveBeenCalledWith(provider.id, false);
  await act(async () => header.querySelector<HTMLButtonElement>(".settings-provider-delete")!.click());
  expect(api.removeProvider).not.toHaveBeenCalled();
  await act(async () => button("Delete provider")!.click());
  expect(api.removeProvider).toHaveBeenCalledWith(provider.id);
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

it("refreshes in the background and preserves the current list when a manual refresh fails", async () => {
  vi.useFakeTimers();
  const catalog = await api.getProviderModels();
  api.getProviderModels.mockResolvedValueOnce({ ...catalog, refreshingCatalog: true });
  await render();
  expect(rows()).toEqual(["GPT-5", "GPT-4"]);
  expect(button("Refresh models")!.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(button("Refresh models")!.disabled).toBe(false);
  api.refreshProviderModels.mockRejectedValueOnce(new Error("offline"));
  await act(async () => button("Refresh models")!.click());
  expect(api.refreshProviderModels).toHaveBeenCalledWith("openai");
  expect(rows()).toEqual(["GPT-5", "GPT-4"]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Your existing models are still available");
  await act(async () => button("Refresh models")!.click());
  expect(api.refreshProviderModels).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("pauses background polling while the user saves model visibility", async () => {
  vi.useFakeTimers();
  const catalog = await api.getProviderModels();
  api.getProviderModels.mockClear();
  api.getProviderModels.mockResolvedValueOnce({ ...catalog, refreshingCatalog: true });
  let save!: (settings: ProviderModelSettings) => void;
  api.setProviderModelVisibility.mockImplementationOnce(() => new Promise((resolve) => { save = resolve; }));
  await render();
  await act(async () => button("Edit")!.click());
  const checkbox = host.querySelector<HTMLInputElement>('.provider-model-row input[type="checkbox"]')!;
  await act(async () => checkbox.click());
  expect(api.setProviderModelVisibility).toHaveBeenCalledWith("openai", ["gpt-4"], false);
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(api.getProviderModels).toHaveBeenCalledOnce();
  const saved = { ...catalog, models: catalog.models.map((model) => model.id === "gpt-4" ? { ...model, visible: false } : model) };
  api.getProviderModels.mockResolvedValueOnce(saved);
  await act(async () => save(saved));
  await act(async () => vi.advanceTimersByTimeAsync(1_000));
  expect(checkbox.checked).toBe(false);
  expect(api.getProviderModels).toHaveBeenCalledTimes(2);
});
