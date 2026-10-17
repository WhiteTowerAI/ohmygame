// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentModelCatalog,
  CustomProviderDetails,
  ModelAuthEvent,
  ProviderSummary,
} from "../src/shared/contracts.js";
import {
  INITIAL_ONBOARDING_STATE,
  type OnboardingState,
  type OnboardingStep,
} from "../src/shared/onboarding.js";

const api = vi.hoisted(() => ({
  startModelProviderLogin: vi.fn(),
  cancelModelAuth: vi.fn(),
  respondToModelAuth: vi.fn(),
  subscribeToModelAuth: vi.fn(),
  notifyAgentModelsChanged: vi.fn(),
  getOnboardingState: vi.fn(),
  updateOnboardingState: vi.fn(),
  waitForRuntime: vi.fn(),
  listProviders: vi.fn(),
  listModels: vi.fn(),
  getCustomProvider: vi.fn(),
  discoverCustomProviderModels: vi.fn(),
  saveCustomProvider: vi.fn(),
  setProviderEnabled: vi.fn(),
  updateAgentDefaults: vi.fn(),
}));
vi.doMock(path.resolve("src/renderer/api.ts"), async (original) => ({
  ...(await original<typeof import("../src/renderer/api.js")>()),
  ...api,
}));
const { Onboarding } = await import("../src/renderer/onboarding.js");
const { useModelProviderAuth } =
  await import("../src/renderer/use-model-provider-auth.js");
const { useOnboarding } = await import("../src/renderer/use-onboarding.js");
const { CustomProviderDialog } =
  await import("../src/renderer/custom-provider-dialog.js");

type Stream = { onEvent: (event: ModelAuthEvent) => void; onError: () => void };
const streams: Stream[] = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const provider: ProviderSummary = {
  id: "openrouter",
  name: "OpenRouter",
  configured: false,
  capabilities: ["language"],
  status: "not_configured",
  methods: [{ type: "api_key", label: "API key" }],
};
const catalog: AgentModelCatalog = {
  models: [],
  defaultReasoningLevel: "medium",
};
const customProvider: CustomProviderDetails = {
  id: "custom:test",
  name: "Test provider",
  baseUrl: "http://localhost:11434/v1",
  api: "openai-completions",
  authentication: "none",
  models: [
    {
      id: "test-model",
      name: "Test model",
      api: "openai-completions",
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: false,
      supportsImages: false,
      usages: { language: true },
    },
  ],
  hiddenModelIds: [],
};
beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  streams.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "ohMyGameDesktop", {
    configurable: true,
    value: undefined,
  });
  api.startModelProviderLogin.mockResolvedValue("operation");
  api.cancelModelAuth.mockResolvedValue(undefined);
  api.respondToModelAuth.mockResolvedValue(undefined);
  api.subscribeToModelAuth.mockImplementation((_id, stream) => {
    streams.push(stream);
    return vi.fn();
  });
  api.waitForRuntime.mockResolvedValue(undefined);
  api.getOnboardingState.mockResolvedValue(INITIAL_ONBOARDING_STATE);
  api.updateOnboardingState.mockImplementation(async (state) => ({
    version: 1,
    ...state,
  }));
  api.listProviders.mockResolvedValue([provider]);
  api.listModels.mockResolvedValue(catalog);
  api.getCustomProvider.mockResolvedValue(customProvider);
  api.discoverCustomProviderModels.mockResolvedValue({
    models: customProvider.models,
  });
  api.saveCustomProvider.mockResolvedValue(customProvider);
  api.setProviderEnabled.mockResolvedValue(undefined);
  api.updateAgentDefaults.mockResolvedValue(undefined);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function stepButton(step: OnboardingStep) {
  return container.querySelector<HTMLButtonElement>(
    `.onboarding-progress > button:nth-child(${step === "welcome" ? 1 : 2})`,
  )!;
}
function providerButton(name: string, label: string) {
  const row = [...container.querySelectorAll('[role="group"]')].find(
    (item) => item.getAttribute("aria-label") === name,
  );
  const result = [...(row?.querySelectorAll("button") ?? [])].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing ${name} button: ${label}`);
  return result;
}
async function openCustomProvider() {
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Add custom provider"]')!
      .click(),
  );
}
async function fillInput(placeholder: string, value: string) {
  const input = [...container.querySelectorAll("input")].find(
    (item) => item.placeholder === placeholder,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function fillCustomProvider() {
  await fillInput("My provider", "Test provider");
  await fillInput("https://api.example.com/v1", customProvider.baseUrl);
  const authentication = [...container.querySelectorAll("label")]
    .find(
      (label) => label.querySelector("span")?.textContent === "Authentication",
    )!
    .querySelector("select")!;
  await act(async () => {
    authentication.value = "none";
    authentication.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function event(value: Omit<ModelAuthEvent, "id" | "operationId">) {
  await act(async () =>
    streams
      .at(-1)!
      .onEvent({ id: 1, operationId: "operation", ...value } as ModelAuthEvent),
  );
}
const secretPrompt = (id: string): ModelAuthEvent => ({
  id: 1,
  operationId: "operation",
  type: "prompt",
  promptId: id,
  prompt: { type: "secret", message: "API key" },
});

describe("shared model authorization lifecycle", () => {
  let auth: ReturnType<typeof useModelProviderAuth>;
  const completed = vi.fn(),
    cancelled = vi.fn(),
    failed = vi.fn();
  function Harness({ method = "api_key" }: { method?: "api_key" | "oauth" }) {
    auth = useModelProviderAuth({
      providerId: "openrouter",
      method,
      onCompleted: completed,
      onCancelled: cancelled,
      onFailed: failed,
    });
    return null;
  }
  beforeEach(() => {
    completed.mockClear();
    cancelled.mockClear();
    failed.mockClear();
  });

  it("cancels a start that resolves after its screen has closed", async () => {
    const start = deferred<string>();
    api.startModelProviderLogin.mockReturnValue(start.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(null));
    await act(async () => start.resolve("late-operation"));
    expect(api.cancelModelAuth).toHaveBeenCalledWith("late-operation");
    expect(api.subscribeToModelAuth).not.toHaveBeenCalled();
  });

  it("retains the next prompt when it arrives before the response request resolves", async () => {
    const response = deferred<void>();
    api.respondToModelAuth.mockReturnValue(response.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => streams[0]!.onEvent(secretPrompt("first")));
    let pending!: Promise<void>;
    await act(async () => {
      pending = auth.respond("test-key");
    });
    expect(auth.responding).toBe(true);
    await act(async () => streams[0]!.onEvent(secretPrompt("second")));
    await act(async () => {
      response.resolve();
      await pending;
    });
    expect(auth.prompt?.id).toBe("second");
    expect(auth.responding).toBe(false);
  });

  it("opens an OAuth URL once and does not cancel a completed flow", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => root.render(<Harness method="oauth" />));
    const notification = {
      type: "notification" as const,
      notification: {
        type: "auth_url" as const,
        url: "https://auth.example.test/login",
      },
    };
    await event(notification);
    await event(notification);
    expect(open).toHaveBeenCalledOnce();
    await event({ type: "completed" });
    expect(completed).toHaveBeenCalledOnce();
    expect(api.notifyAgentModelsChanged).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(api.cancelModelAuth).not.toHaveBeenCalled();
  });

  it("ignores stale authorization events after cancellation", async () => {
    await act(async () => root.render(<Harness />));
    const stream = streams[0]!;
    await act(async () => auth.cancel());
    await act(async () => {
      stream.onEvent({ id: 1, operationId: "operation", type: "cancelled" });
      stream.onEvent({ id: 2, operationId: "operation", type: "completed" });
      stream.onError();
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(completed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
});

describe("first-run screens", () => {
  it("keeps saved built-in and custom providers connected without reopening their credentials", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
      {
        ...provider,
        id: customProvider.id,
        name: "Local server",
        custom: true,
        configured: true,
        status: "connected",
      },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    for (const name of ["OpenRouter", "Local server"]) {
      expect(providerButton(name, "Connected").disabled).toBe(true);
      await act(async () => providerButton(name, "Connected").click());
    }
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
    expect(api.getCustomProvider).not.toHaveBeenCalled();
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
    expect(button("Start creating").disabled).toBe(true);
  });

  it("refreshes a stale provider before starting authorization and preserves its saved connection", async () => {
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    await act(async () => providerButton("OpenRouter", "API key").click());
    expect(providerButton("OpenRouter", "Connected").disabled).toBe(true);
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
  });

  it("enables a saved custom provider without reopening or replacing its credential", async () => {
    api.listProviders.mockResolvedValue([
      {
        ...provider,
        id: customProvider.id,
        name: "Local server",
        custom: true,
        configured: true,
        status: "connected",
        enabled: false,
      },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await act(async () => providerButton("Local server", "Enable").click());
    expect(api.setProviderEnabled).toHaveBeenCalledWith(
      customProvider.id,
      true,
    );
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
    expect(api.getCustomProvider).not.toHaveBeenCalled();
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
  });

  it("preserves a provider configured elsewhere before retrying failed authorization", async () => {
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await act(async () => providerButton("OpenRouter", "API key").click());
    await event({ type: "error", error: "Sign-in failed" } as Omit<
      ModelAuthEvent,
      "id" | "operationId"
    >);
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    await act(async () => button("Retry").click());
    expect(providerButton("OpenRouter", "Connected").disabled).toBe(true);
    expect(api.startModelProviderLogin).toHaveBeenCalledOnce();
    expect(api.respondToModelAuth).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Sign-in failed");
  });

  it("switches steps using the bottom navigation and cancels authorization when leaving", async () => {
    const change = vi.fn().mockResolvedValue(undefined);
    function Harness() {
      const [step, setStep] = useState<OnboardingStep>("welcome");
      return (
        <Onboarding
          step={step}
          onStepChange={async (next) => {
            await change(next);
            setStep(next);
          }}
          onFinish={vi.fn()}
        />
      );
    }
    await act(async () => root.render(<Harness />));
    expect(stepButton("welcome").getAttribute("aria-current")).toBe("step");
    await act(async () => stepButton("connect").click());
    expect(change).toHaveBeenLastCalledWith("connect");
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
    expect(container.textContent).not.toContain("Back");
    await act(async () => providerButton("OpenRouter", "API key").click());
    await act(async () => stepButton("welcome").click());
    expect(change).toHaveBeenLastCalledWith("welcome");
    expect(api.cancelModelAuth).toHaveBeenCalledWith("operation");
    await act(async () => stepButton("connect").click());
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
    expect(stepButton("connect").getAttribute("aria-current")).toBe("step");
    expect(stepButton("welcome").hasAttribute("aria-current")).toBe(false);
  });

  it("hides the legacy Codex entry and starts the chosen provider's authorization", async () => {
    api.listProviders.mockResolvedValue(
      ["openai-codex", "openai"].map((id) => ({
        ...provider,
        id,
        name: id,
        methods: [{ type: "oauth", label: "Sign in" }],
      })),
    );
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
    expect(providerButton("openai", "Sign in")).toBeDefined();
    expect(container.querySelector('[aria-label="openai-codex"]')).toBeNull();
    expect(container.textContent).not.toContain("More providers");
    await act(async () => providerButton("openai", "Sign in").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith("openai", "oauth");
  });

  it("offers chat sign-in when OpenAI only has an image connection", async () => {
    const openai: ProviderSummary = {
      ...provider,
      id: "openai",
      name: "OpenAI",
      configured: true,
      languageConfigured: false,
      imageConfigured: true,
      status: "connected",
      methods: [{ type: "oauth", label: "Sign in" }],
    };
    api.listProviders.mockResolvedValue([openai]);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(container.textContent).not.toContain("Connected");
    await act(async () => providerButton("OpenAI", "Sign in").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith("openai", "oauth");
  });

  it("lets a failed step save be retried", async () => {
    const step = vi
      .fn()
      .mockRejectedValueOnce(new Error("Could not save setup"))
      .mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Onboarding step="welcome" onStepChange={step} onFinish={finish} />,
      ),
    );
    expect(container.textContent).not.toContain("Skip for now");
    expect(container.textContent).not.toContain(
      "Your projects stay on this machine.",
    );
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Could not save setup");
    await act(async () => button("Retry").click());
    expect(step).toHaveBeenCalledTimes(2);
    expect(step).toHaveBeenLastCalledWith("connect");
    expect(finish).not.toHaveBeenCalled();
  });

  it("allows entering without a model and retries a failed preference save", async () => {
    const save = deferred<void>();
    const finish = vi
      .fn()
      .mockReturnValueOnce(save.promise)
      .mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    expect(container.textContent).not.toContain("Skip for now");
    expect(button("Start creating").disabled).toBe(true);
    await act(async () => button("Start creating").click());
    expect(finish).not.toHaveBeenCalled();
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
    expect(button("Skip and start").disabled).toBe(true);
    expect(button("Start creating").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    expect(stepButton("connect").disabled).toBe(true);
    await act(async () => save.reject(new Error("Could not save setup")));
    expect(container.textContent).toContain("Could not save setup");
    expect(button("Skip and start").disabled).toBe(false);
    expect(button("Start creating").disabled).toBe(true);
    await act(async () => button("Retry").click());
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith("skipped");
    expect(container.textContent).not.toContain("Could not save setup");
  });

  it("records completion after connecting a provider with a visible language model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    expect(button("Start creating").disabled).toBe(true);
    await act(async () => providerButton("OpenRouter", "API key").click());
    expect(container.textContent).not.toContain("Start creating");
    expect(api.startModelProviderLogin).toHaveBeenCalledWith(
      "openrouter",
      "api_key",
    );
    await act(async () => streams[0]!.onEvent(secretPrompt("key")));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: "openrouter",
          id: "test",
          name: "Test model",
          reasoningLevels: ["off"],
        },
      ],
    });
    api.listProviders.mockResolvedValue([{ ...provider, configured: true }]);
    await event({ type: "completed" });
    expect(container.textContent).toContain("Ready with Test model");
    expect(button("Start creating").disabled).toBe(false);
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
  });

  it("makes the provider connected during setup supply its recommended default model", async () => {
    const anthropic: ProviderSummary = {
      ...provider,
      id: "anthropic",
      name: "Anthropic",
    };
    const models: AgentModelCatalog["models"] = [
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        providerName: "OpenAI",
        reasoningLevels: ["low", "medium"],
      },
      {
        provider: "anthropic",
        id: "claude-3-haiku",
        name: "Claude 3 Haiku",
        providerName: "Anthropic",
        reasoningLevels: ["off"],
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        providerName: "Anthropic",
        reasoningLevels: ["off", "high"],
      },
    ];
    let defaultModel = { provider: "openai", id: "gpt-5.5" };
    api.listProviders.mockResolvedValue([anthropic]);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await act(async () => providerButton("Anthropic", "API key").click());
    api.listProviders.mockResolvedValue([
      { ...anthropic, configured: true, status: "connected" },
    ]);
    api.listModels.mockImplementation(async () => ({
      ...catalog,
      models,
      defaultModel,
    }));
    api.updateAgentDefaults.mockImplementation(async ({ model }) => {
      defaultModel = { provider: model.provider, id: model.id };
    });
    await event({ type: "completed" });
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: models[2],
      reasoningLevel: "high",
    });
    const ready = container.querySelector(".onboarding-ready")!;
    expect(ready.textContent).toContain("Anthropic");
    expect(
      ready.querySelector<HTMLSelectElement>(
        'select[aria-label="Default model"]',
      )!.value,
    ).toBe("anthropic/claude-opus-4-8");
    expect(container.textContent).not.toContain("Skip and start");
  });

  it("keeps setup busy while saving the connected provider's default across catalog refreshes", async () => {
    const save = deferred<void>();
    const finish = vi.fn();
    const models: AgentModelCatalog["models"] = [
      {
        provider: provider.id,
        providerName: provider.name,
        id: "test-model",
        name: "Test model",
        reasoningLevels: ["medium"],
      },
    ];
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    await act(async () => providerButton(provider.name, "API key").click());
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({ ...catalog, models });
    api.updateAgentDefaults.mockReturnValue(save.promise);
    api.notifyAgentModelsChanged.mockImplementation(() => {
      window.dispatchEvent(new Event("ohmygame-models-changed"));
    });

    await event({ type: "completed" });
    expect(api.updateAgentDefaults).toHaveBeenCalledOnce();
    expect(button("Start creating").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    await act(async () => button("Start creating").click());
    expect(finish).not.toHaveBeenCalled();

    await act(async () => save.resolve());
    expect(button("Start creating").disabled).toBe(false);
  });

  it("retries saving the connected provider's default without repeating authorization", async () => {
    const models: AgentModelCatalog["models"] = [
      {
        provider: provider.id,
        providerName: provider.name,
        id: "test-model",
        name: "Test model",
        reasoningLevels: ["medium"],
      },
    ];
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await act(async () => providerButton(provider.name, "API key").click());
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({ ...catalog, models });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Saving default failed"),
    );

    await event({ type: "completed" });
    expect(container.textContent).toContain("Saving default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.startModelProviderLogin).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Saving default failed");
  });

  it("retries selecting a re-enabled provider's default after the enable has already succeeded", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, enabled: false },
    ]);
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: provider.id,
          providerName: provider.name,
          id: "test-model",
          name: "Test model",
          reasoningLevels: ["medium"],
        },
      ],
    });
    api.setProviderEnabled.mockImplementation(async () => {
      api.listProviders.mockResolvedValue([
        { ...provider, configured: true, enabled: true },
      ]);
    });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Saving default failed"),
    );
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );

    await act(async () => providerButton(provider.name, "Enable").click());
    expect(container.textContent).toContain("Saving default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.setProviderEnabled).toHaveBeenCalledOnce();
  });

  it("finishes saving a custom provider's default after the provider form has stopped saving", async () => {
    const saveDefault = deferred<void>();
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await openCustomProvider();
    await fillCustomProvider();
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: customProvider.id,
          providerName: customProvider.name,
          id: "test-model",
          name: "Test model",
          reasoningLevels: ["off"],
        },
      ],
    });
    api.updateAgentDefaults.mockReturnValue(saveDefault.promise);

    await act(async () => button("Add provider").click());
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(api.saveCustomProvider).toHaveBeenCalledOnce();
    expect(api.updateAgentDefaults).toHaveBeenCalledOnce();
    expect(button("Start creating").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);

    await act(async () => saveDefault.resolve());
    expect(button("Start creating").disabled).toBe(false);
  });

  it("changes the default model from the ready line", async () => {
    const models: AgentModelCatalog["models"] = [
      {
        provider: "openrouter",
        id: "first",
        name: "First",
        providerName: "OpenRouter",
        reasoningLevels: ["medium"],
      },
      {
        provider: "openrouter",
        id: "second",
        name: "Second",
        providerName: "OpenRouter",
        reasoningLevels: ["off"],
      },
    ];
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({
      ...catalog,
      models,
      defaultModel: { provider: "openrouter", id: "first" },
    });
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Default model"]',
    )!;
    expect(select.value).toBe("openrouter/first");
    await act(async () => {
      select.value = "openrouter/second";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: models[1],
      reasoningLevel: "off",
    });
    expect(api.listModels).toHaveBeenCalledTimes(2);
  });

  it("lists connected and popular providers first and keeps the rest under More", async () => {
    api.listProviders.mockResolvedValue(
      [
        { id: "anthropic", name: "Anthropic" },
        { id: "baseten", name: "Baseten", configured: true },
        { id: "cerebras", name: "Cerebras" },
        { id: "openrouter", name: "OpenRouter" },
      ].map((item) => ({ ...provider, ...item })),
    );
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    const rows = () =>
      [...container.querySelectorAll('[role="group"]')].map((row) =>
        row.getAttribute("aria-label"),
      );
    expect(rows()).toEqual(["Baseten", "Anthropic", "OpenRouter"]);
    await act(async () => button("More providers (1)").click());
    expect(rows()).toEqual(["Baseten", "Anthropic", "OpenRouter", "Cerebras"]);
    await act(async () => button("More providers (1)").click());
    await fillInput("Search providers…", "cere");
    expect(rows()).toEqual(["Cerebras"]);
    expect(container.textContent).not.toContain("More providers");
  });

  it("retries failed authorization and lets users return to enter without a model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    await act(async () => providerButton("OpenRouter", "API key").click());
    await event({ type: "error", error: "Sign-in failed" } as Omit<
      ModelAuthEvent,
      "id" | "operationId"
    >);
    expect(container.textContent).toContain("Sign-in failed");
    await act(async () => button("Retry").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledTimes(2);
    await act(async () => stepButton("connect").click());
    expect(api.cancelModelAuth).toHaveBeenCalledWith("operation");
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });

  it("keeps catalog failures recoverable", async () => {
    api.listModels.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Retry").click());
    expect(container.textContent).not.toContain("Catalog unavailable");
    expect(providerButton("OpenRouter", "API key")).toBeDefined();
  });

  it("allows entering the studio when the model catalog cannot load", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    api.listModels.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });

  it("opens the shared form inline and returns without changing the main step", async () => {
    const step = vi.fn(),
      finish = vi.fn();
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={step} onFinish={finish} />,
      ),
    );
    expect(container.textContent).not.toContain(
      "One language model is all you need to start.",
    );
    expect(container.textContent).not.toContain("Local or custom");
    expect(container.textContent).not.toContain(
      "Optional image, video & 3D models",
    );
    await openCustomProvider();
    expect(container.textContent).not.toContain("Start creating");
    expect(
      container.querySelector('section[aria-label="Custom provider"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector(".project-settings-backdrop")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('input[placeholder="My provider"]'),
    );
    await act(async () => stepButton("connect").click());
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
    expect(step).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("refreshes language models after adding a custom provider without finishing automatically", async () => {
    const finish = vi.fn();
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    await openCustomProvider();
    await fillCustomProvider();
    await act(async () => button("Fetch").click());
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Enable Test model"]')!
        .click(),
    );
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: customProvider.id,
          id: "test-model",
          name: "Test model",
          reasoningLevels: ["off"],
        },
      ],
    });
    await act(async () => button("Add provider").click());
    expect(api.saveCustomProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Test provider",
        baseUrl: customProvider.baseUrl,
        authentication: "none",
        models: customProvider.models,
        hiddenModelIds: [],
      }),
      undefined,
    );
    expect(container.textContent).toContain("Ready with Test model");
    expect(finish).not.toHaveBeenCalled();
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
  });

  it("keeps save failures recoverable and prevents leaving while saving", async () => {
    const save = deferred<CustomProviderDetails>();
    api.saveCustomProvider.mockReturnValueOnce(save.promise);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await openCustomProvider();
    await fillCustomProvider();
    await act(async () => button("Add provider").click());
    expect(stepButton("welcome").disabled).toBe(true);
    expect(stepButton("connect").disabled).toBe(true);
    await act(async () => stepButton("welcome").click());
    expect(button("Cancel").disabled).toBe(true);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(container.querySelector("h1")?.textContent).toBe(
      "Add your provider.",
    );
    await act(async () => save.reject(new Error("Could not save provider")));
    expect(container.textContent).toContain("Could not save provider");
    expect(stepButton("welcome").disabled).toBe(false);
    expect(stepButton("connect").disabled).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>(
        'input[placeholder="My provider"]',
      )?.value,
    ).toBe("Test provider");
    api.saveCustomProvider.mockResolvedValueOnce(customProvider);
    await act(async () => button("Add provider").click());
    expect(api.saveCustomProvider).toHaveBeenCalledTimes(2);
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
  });

  it("aborts pending model discovery when returning from the inline form", async () => {
    const discovery = deferred<{ models: CustomProviderDetails["models"] }>();
    api.discoverCustomProviderModels.mockReturnValue(discovery.promise);
    await act(async () =>
      root.render(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await openCustomProvider();
    await fillCustomProvider();
    await act(async () => button("Fetch").click());
    const signal = api.discoverCustomProviderModels.mock
      .calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await act(async () => button("Cancel").click());
    expect(signal.aborted).toBe(true);
    await act(async () => discovery.resolve({ models: customProvider.models }));
    expect(container.querySelector("h1")?.textContent).toBe(
      "Choose your provider.",
    );
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
  });

  it("retains the modal presentation for provider settings", async () => {
    const close = vi.fn();
    await act(async () =>
      root.render(
        <CustomProviderDialog
          settings={customProvider}
          onClose={close}
          onSaved={vi.fn()}
        />,
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.contains(dialog)).toBe(false);
    expect(document.querySelector(".project-settings-backdrop")).not.toBeNull();
    expect(
      dialog.querySelector<HTMLInputElement>('input[placeholder="My provider"]')
        ?.value,
    ).toBe("Test provider");
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("onboarding navigation state", () => {
  let state: ReturnType<typeof useOnboarding>;
  function Harness({ eligible = true }: { eligible?: boolean }) {
    state = useOnboarding(eligible);
    return null;
  }

  it("reads the persisted connection step and keeps explicit writes ahead of stale reads", async () => {
    const read = deferred<OnboardingState>();
    api.getOnboardingState.mockReturnValue(read.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => state.save({ status: "skipped", step: "connect" }));
    await act(async () =>
      read.resolve({ version: 1, status: "pending", step: "connect" }),
    );
    expect(state.state?.status).toBe("skipped");
    await act(async () => root.render(null));
    api.getOnboardingState.mockResolvedValue({
      version: 1,
      status: "pending",
      step: "connect",
    });
    await act(async () => root.render(<Harness />));
    expect(state.state?.step).toBe("connect");
  });

  it("leaves project routes alone and reopens from settings without resetting saved state immediately", async () => {
    await act(async () => root.render(<Harness eligible={false} />));
    expect(api.getOnboardingState).not.toHaveBeenCalled();
    await act(async () => state.open());
    expect(state.replaying).toBe(true);
    expect(state.state).toEqual(INITIAL_ONBOARDING_STATE);
    expect(api.updateOnboardingState).not.toHaveBeenCalled();
    await act(async () => state.save({ status: "skipped", step: "welcome" }));
    expect(state.replaying).toBe(false);
  });
});
