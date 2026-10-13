// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CustomProviderDetails, ProviderSummary } from "../src/shared/contracts.js";
import { defaultModel3DSettings } from "../src/shared/custom-models.js";

const api = { balance: vi.fn(), providers: vi.fn(), custom: vi.fn() };
vi.doMock(path.resolve("src/renderer/api.ts"), () => ({
  model3DBalance: api.balance, listProviders: api.providers, getCustomProvider: api.custom, MODELS_CHANGED_EVENT: "ohmygame-models-changed",
}));
vi.doMock(path.resolve("src/renderer/auth.tsx"), () => ({ useAuth: () => ({ state: { status: "signed-in", user: { id: "u", name: "Player" } }, openSignIn: vi.fn() }) }));
vi.doMock(path.resolve("src/renderer/provider-models.tsx"), () => ({ ProviderModels: () => <div>Models</div> }));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.balance.mockResolvedValue({ balance: 10 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const provider = (id: string, custom = false): ProviderSummary => ({ id, name: id, configured: true, status: "connected", capabilities: ["3d"], methods: [{ type: "api_key", label: "API key" }], custom });
const render = (value: ProviderSummary) => act(async () => root.render(<ModelsSettings view={{ page: "provider", provider: value }} onViewChange={() => {}} />));

it.each(["meshy", "tripo"])("shows %s account credits with a stable connection ID", async (id) => {
  await render(provider(id));
  expect(api.balance).toHaveBeenCalledWith({ provider: id, id: "connection" });
  expect(container.querySelector('[aria-label="API balance"]')?.textContent).toContain("10 credits");
});

it("keeps Hyper3D's free daily quota separate from its API-key balance", async () => {
  const hyper3d = provider("hyper3d");
  api.providers.mockResolvedValue([hyper3d, { ...provider("cloud-hyper3d"), cloud: { userId: "u", availability: "ready", quota: {
    unit: "credits", personal: { remaining: 3, limit: 5, reserved: 0, resetsAt: "2026-10-12T00:00:00Z" },
  } } }]);
  await render(hyper3d);
  expect(container.querySelector('[aria-label="Daily quota"]')?.textContent).toContain("3 / 5 credits");
  expect(container.querySelector('[aria-label="API balance"]')?.textContent).toContain("10 credits");
  expect(api.balance).toHaveBeenCalledWith({ provider: "hyper3d", id: "connection" });
});

it("deduplicates custom balances while keeping distinct model-level endpoints separate", async () => {
  const modelFields = { api: "openai-completions", contextWindow: 4096, maxTokens: 1024, reasoning: false, supportsImages: false };
  const details: CustomProviderDetails = { id: "studio", name: "Studio", baseUrl: "https://studio.test/v3", api: "openai-completions", authentication: "none", modelConfigurationVersion: 2, hiddenModelIds: ["first"], models: [
    { ...modelFields, id: "first", name: "First", usages: { "3d": defaultModel3DSettings("standard", "tripo") } },
    { ...modelFields, id: "second", name: "Second", usages: { "3d": { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "https://studio.test/v3/" } } },
    { ...modelFields, id: "other", name: "Other account", usages: { "3d": { ...defaultModel3DSettings("standard", "tripo"), baseUrl: "https://other.test/v3" } } },
  ] };
  api.custom.mockResolvedValue(details);
  await render(provider("studio", true));
  expect(api.balance).toHaveBeenCalledTimes(2);
  expect(api.balance).toHaveBeenCalledWith({ provider: "studio", id: "first" });
  expect(api.balance).toHaveBeenCalledWith({ provider: "studio", id: "other" });
  expect(container.querySelector('[aria-label="API balance · First"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="API balance · Other account"]')).not.toBeNull();
});
