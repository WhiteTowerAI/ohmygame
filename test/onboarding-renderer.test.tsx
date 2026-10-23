// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
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
  listAgentRuntimes: vi.fn(),
  updateAgentRuntime: vi.fn(),
  loginAgentRuntime: vi.fn(),
  recheckAgentRuntime: vi.fn(),
  listModels: vi.fn(),
  listImageModelCatalog: vi.fn(),
  listVideoModelCatalog: vi.fn(),
  listModel3DCatalog: vi.fn(),
  setDefaultMediaModel: vi.fn(),
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
const { Onboarding, OnboardingArrival } =
  await import("../src/renderer/onboarding.js");
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
  api.notifyAgentModelsChanged.mockImplementation(() => {
    window.dispatchEvent(new Event("ohmygame-models-changed"));
  });
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
  api.listAgentRuntimes.mockResolvedValue([]);
  api.listModels.mockResolvedValue(catalog);
  api.listImageModelCatalog.mockResolvedValue({ models: [] });
  api.listVideoModelCatalog.mockResolvedValue({ models: [] });
  api.listModel3DCatalog.mockResolvedValue({ models: [] });
  api.getCustomProvider.mockResolvedValue(customProvider);
  api.discoverCustomProviderModels.mockResolvedValue({
    models: customProvider.models,
  });
  api.saveCustomProvider.mockImplementation(async () => {
    api.notifyAgentModelsChanged();
    return customProvider;
  });
  api.setProviderEnabled.mockImplementation(async (id, enabled) => {
    api.notifyAgentModelsChanged();
    return { ...provider, id, configured: true, enabled };
  });
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
    (item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function stepButton(step: OnboardingStep) {
  return container.querySelector<HTMLButtonElement>(
    `.onboarding-progress > button:nth-child(${step === "welcome" ? 1 : step === "connect" ? 2 : 3})`,
  )!;
}
function providerButton(name: string, label: string) {
  const row = [...container.querySelectorAll('[role="group"]')].find(
    (item) => item.getAttribute("aria-label") === name,
  );
  const result = [...(row?.querySelectorAll("button") ?? [])].find(
    (item) =>
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label,
  );
  if (!result) throw new Error(`Missing ${name} button: ${label}`);
  return result;
}
async function chooseAgent(name: string) {
  if (!container.querySelector(".onboarding-agent-options"))
    await act(async () => button("Switch").click());
  await act(async () => agentButton(name).click());
}
async function showConnection(
  element: ReactNode,
  agent: string | false = "OhMyGame",
) {
  await act(async () => root.render(element));
  if (agent) await chooseAgent(agent);
}
function agentButton(name: string) {
  const result = container.querySelector<HTMLButtonElement>(
    `.onboarding-agent-option[aria-label="${name}"]`,
  );
  if (!result) throw new Error(`Missing agent: ${name}`);
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    for (const name of ["OpenRouter", "Local server"]) {
      expect(providerButton(name, "Connected").disabled).toBe(true);
    }
    expect(api.startModelProviderLogin).not.toHaveBeenCalled();
    expect(api.getCustomProvider).not.toHaveBeenCalled();
    expect(api.saveCustomProvider).not.toHaveBeenCalled();
    expect(button("Next").disabled).toBe(true);
  });

  it("refreshes a stale provider before starting authorization and preserves its saved connection", async () => {
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    expect(container.querySelector(".onboarding-welcome-static")).toBeNull();
    await act(async () => stepButton("connect").click());
    expect(change).toHaveBeenLastCalledWith("connect");
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
    expect(container.textContent).not.toContain("Back");
    await chooseAgent("OhMyGame");
    await act(async () => providerButton("OpenRouter", "API key").click());
    await act(async () => stepButton("welcome").click());
    expect(change).toHaveBeenLastCalledWith("welcome");
    expect(
      container.querySelector(".onboarding-welcome-static"),
    ).not.toBeNull();
    expect(api.cancelModelAuth).toHaveBeenCalledWith("operation");
    await act(async () => stepButton("connect").click());
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
    expect(stepButton("connect").getAttribute("aria-current")).toBe("step");
    expect(stepButton("welcome").hasAttribute("aria-current")).toBe(false);
  });

  it.each(["connect", "media"] as const)(
    "skips the welcome intro when returning from a resumed %s step",
    async (step) => {
      const onStepChange = vi.fn();
      const onFinish = vi.fn();
      await act(async () =>
        root.render(
          <Onboarding
            step={step}
            onStepChange={onStepChange}
            onFinish={onFinish}
          />,
        ),
      );
      await act(async () =>
        root.render(
          <Onboarding
            step="welcome"
            onStepChange={onStepChange}
            onFinish={onFinish}
          />,
        ),
      );
      expect(
        container.querySelector(".onboarding-welcome-static"),
      ).not.toBeNull();
      expect(button("Next").disabled).toBe(false);
      expect(container.querySelector("h1")?.textContent).toBe(
        "Your own game studio.",
      );
    },
  );

  it("hides the legacy Codex entry and starts the chosen provider's authorization", async () => {
    api.listProviders.mockResolvedValue(
      ["openai-codex", "openai"].map((id) => ({
        ...provider,
        id,
        name: id,
        methods: [{ type: "oauth", label: "Sign in" }],
      })),
    );
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(container.textContent).not.toContain("Skip for now");
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Next").click());
    expect(finish).not.toHaveBeenCalled();
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
    expect(button("Skip and start").disabled).toBe(true);
    expect(button("Next").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    expect(stepButton("connect").disabled).toBe(true);
    await act(async () => save.reject(new Error("Could not save setup")));
    expect(container.textContent).toContain("Could not save setup");
    expect(button("Skip and start").disabled).toBe(false);
    expect(button("Next").disabled).toBe(true);
    await act(async () => button("Retry").click());
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish).toHaveBeenLastCalledWith("skipped");
    expect(container.textContent).not.toContain("Could not save setup");
  });

  it("records completion after connecting a provider with a visible language model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(button("Next").disabled).toBe(true);
    await act(async () => providerButton("OpenRouter", "API key").click());
    expect(container.textContent).not.toContain("Next");
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
    expect(container.querySelector('[aria-label="Default model"]')).toBeNull();
    expect(button("Next").disabled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: models[2],
      reasoningLevel: "high",
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    const ready = container.querySelector(".onboarding-ready")!;
    expect(ready.textContent).toContain("Anthropic");
    expect(
      ready
        .querySelector('button[aria-haspopup="listbox"]')
        ?.getAttribute("aria-label"),
    ).toBe("Default model: Claude Opus 4.8");
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    await act(async () => providerButton(provider.name, "API key").click());
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, status: "connected" },
    ]);
    api.listModels.mockResolvedValue({ ...catalog, models });
    api.updateAgentDefaults.mockReturnValue(save.promise);

    await event({ type: "completed" });
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledOnce();
    expect(button("Next").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);
    await act(async () => button("Next").click());
    expect(finish).not.toHaveBeenCalled();

    await act(async () => save.resolve());
    expect(button("Next").disabled).toBe(false);
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    await act(async () => button("Next").click());
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
      api.notifyAgentModelsChanged();
      return { ...provider, configured: true, enabled: true };
    });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Saving default failed"),
    );
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );

    await act(async () => providerButton(provider.name, "Enable").click());
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Saving default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.setProviderEnabled).toHaveBeenCalledOnce();
  });

  it("finishes saving a custom provider's default after the provider form has stopped saving", async () => {
    const saveDefault = deferred<void>();
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledOnce();
    expect(button("Next").disabled).toBe(true);
    expect(stepButton("welcome").disabled).toBe(true);

    await act(async () => saveDefault.resolve());
    expect(button("Next").disabled).toBe(false);
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    const select = container.querySelector<HTMLButtonElement>(
      ".onboarding-model-select > button",
    )!;
    expect(select.getAttribute("aria-label")).toBe("Default model: First");
    await act(async () => select.click());
    const menu = document.querySelector<HTMLDivElement>(".canvas-chip-menu")!;
    expect(menu.parentElement).toBe(document.body);
    expect(container.contains(menu)).toBe(false);
    const second = menu.querySelector<HTMLButtonElement>(
      '[role="option"]:last-child',
    )!;
    expect(second.textContent).toContain("Second");
    await act(async () => second.click());
    expect(document.querySelector(".canvas-chip-menu")).toBeNull();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(select.getAttribute("aria-label")).toBe("Default model: Second");
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: models[1],
      reasoningLevel: "off",
    });
    expect(api.listModels).toHaveBeenCalledOnce();
  });

  it("lists connected and popular providers first and removes More after revealing the rest", async () => {
    api.listProviders.mockResolvedValue(
      [
        { id: "anthropic", name: "Anthropic" },
        { id: "baseten", name: "Baseten", configured: true },
        { id: "cerebras", name: "Cerebras" },
        { id: "openrouter", name: "OpenRouter" },
      ].map((item) => ({ ...provider, ...item })),
    );
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    const rows = () =>
      [...container.querySelectorAll('.onboarding-picker [role="group"]')].map(
        (row) => row.getAttribute("aria-label"),
      );
    expect(rows()).toEqual(["Baseten", "Anthropic", "OpenRouter"]);
    await act(async () => button("More providers (1)").click());
    expect(rows()).toEqual(["Baseten", "Anthropic", "OpenRouter", "Cerebras"]);
    expect(container.querySelector(".onboarding-more-providers")).toBeNull();
    await fillInput("Search providers…", "cere");
    expect(rows()).toEqual(["Cerebras"]);
    expect(container.textContent).not.toContain("More providers");
    await fillInput("Search providers…", "");
    expect(rows()).toEqual(["Baseten", "Anthropic", "OpenRouter", "Cerebras"]);
    expect(container.querySelector(".onboarding-more-providers")).toBeNull();
  });

  it("retries failed authorization and lets users return to enter without a model", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
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
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Retry").click());
    expect(container.textContent).not.toContain("Catalog unavailable");
    expect(providerButton("OpenRouter", "API key")).toBeDefined();
  });

  it("allows entering the studio when the model catalog cannot load", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    api.listModels.mockRejectedValueOnce(new Error("Catalog unavailable"));
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
    );
    expect(container.textContent).toContain("Catalog unavailable");
    await act(async () => button("Skip and start").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });

  it("opens the shared form inline and returns without changing the main step", async () => {
    const step = vi.fn(),
      finish = vi.fn();
    await showConnection(
      <Onboarding step="connect" onStepChange={step} onFinish={finish} />,
    );
    expect(container.textContent).not.toContain(
      "One language model is all you need to start.",
    );
    expect(container.textContent).not.toContain("Local or custom");
    expect(container.textContent).not.toContain(
      "Optional image, video & 3D models",
    );
    await openCustomProvider();
    expect(container.textContent).not.toContain("Next");
    expect(
      container.querySelector('section[aria-label="Custom provider"]'),
    ).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector(".project-settings-backdrop")).toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('input[placeholder="My provider"]'),
    );
    await act(async () => stepButton("connect").click());
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
    expect(step).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("refreshes language models after adding a custom provider without finishing automatically", async () => {
    const finish = vi.fn();
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
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
    expect(container.querySelector('[aria-label="Default model"]')).toBeNull();
    expect(finish).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
  });

  it("keeps save failures recoverable and prevents leaving while saving", async () => {
    const save = deferred<CustomProviderDetails>();
    api.saveCustomProvider.mockReturnValueOnce(save.promise);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
  });

  it("aborts pending model discovery when returning from the inline form", async () => {
    const discovery = deferred<{ models: CustomProviderDetails["models"] }>();
    api.discoverCustomProviderModels.mockReturnValue(discovery.promise);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
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
    expect(container.querySelector("h1")?.textContent).toBe("Connect your AI.");
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

describe("three-step setup with coding agents", () => {
  const nativeModel = {
    provider: "codex-cli",
    providerName: "Codex",
    id: "native-test",
    name: "Native model",
    reasoningLevels: [],
    nativeReasoningLevels: ["low", "balanced-custom"],
  } satisfies AgentModelCatalog["models"][number];
  const codex = {
    id: "codex-cli",
    name: "Codex",
    enabled: false,
    installed: true,
    auth: { status: "signed-in", billing: "subscription" },
    commandSandbox: "os",
    permissionMode: "standard",
    diagnostics: [],
  } satisfies import("../src/shared/agent-runtimes.js").AgentRuntimeStatus;

  it("keeps media optional and finishes with a CLI alone", async () => {
    const finish = vi.fn();
    function Flow() {
      const [step, setStep] = useState<OnboardingStep>("welcome");
      return (
        <Onboarding
          step={step}
          onStepChange={async (next) => setStep(next)}
          onFinish={finish}
        />
      );
    }
    api.listAgentRuntimes.mockResolvedValue([codex]);
    api.updateAgentRuntime.mockImplementation(async () => {
      api.listAgentRuntimes.mockResolvedValue([{ ...codex, enabled: true }]);
      api.listModels.mockResolvedValue({ ...catalog, models: [nativeModel] });
      return { ...codex, enabled: true };
    });
    api.updateAgentDefaults.mockImplementation(
      async ({ model, nativeReasoningLevel }) => {
        api.listModels.mockResolvedValue({
          ...catalog,
          models: [nativeModel],
          defaultModel: model,
          defaultNativeReasoningLevel: nativeReasoningLevel,
        });
      },
    );
    await act(async () => root.render(<Flow />));
    expect(
      container.querySelectorAll(".onboarding-progress > button"),
    ).toHaveLength(3);
    await act(async () => button("Next").click());
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
    expect(button("Next").disabled).toBe(true);
    expect(container.querySelector('[aria-label="Default model"]')).toBeNull();
    await chooseAgent("Codex");
    expect(api.updateAgentRuntime).toHaveBeenCalledWith("codex-cli", {
      enabled: true,
    });
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledWith({ agentRuntimes: true });
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: nativeModel,
      nativeReasoningLevel: "low",
    });
    expect(container.querySelector("h1")?.textContent).toBe(
      "Add creative tools.",
    );
    expect(container.textContent).not.toContain("Native model");
    expect(container.querySelector(".onboarding-agents")).toBeNull();
    expect(finish).not.toHaveBeenCalled();
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
  });

  it("saves native effort without sending the built-in reasoning enum", async () => {
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [nativeModel],
      defaultNativeReasoningLevel: "balanced-custom",
    });
    api.listAgentRuntimes.mockResolvedValue([{ ...codex, enabled: true }]);
    const finish = vi.fn();
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={finish} />,
      "Codex",
    );
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: nativeModel,
      nativeReasoningLevel: "balanced-custom",
    });
    expect(api.updateAgentDefaults.mock.calls[0][0]).not.toHaveProperty(
      "reasoningLevel",
    );
  });

  it("keeps provider setup available while CLI discovery is slow or fails", async () => {
    const scan = deferred<(typeof codex)[]>();
    api.listAgentRuntimes.mockReturnValue(scan.promise);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    expect(providerButton("OpenRouter", "API key").disabled).toBe(false);
    await act(async () => scan.reject(new Error("Discovery unavailable")));
    expect(container.textContent).toContain("Discovery unavailable");
    expect(providerButton("OpenRouter", "API key").disabled).toBe(false);
    api.listAgentRuntimes.mockResolvedValue([codex]);
    await act(async () => button("Switch").click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Rescan"]')!
        .click(),
    );
    expect(agentButton("Codex")).toBeDefined();
    expect(container.textContent).not.toContain("Discovery unavailable");
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  });

  it.each(["failed", "pending"])(
    "keeps CLI models usable when the provider list is %s",
    async (failure) => {
      api.listProviders.mockImplementation(() =>
        failure === "failed"
          ? Promise.reject(new Error("Provider list unavailable"))
          : new Promise(() => {}),
      );
      api.listModels.mockResolvedValue({ ...catalog, models: [nativeModel] });
      api.listAgentRuntimes.mockResolvedValue([{ ...codex, enabled: true }]);
      const change = vi.fn();
      await showConnection(
        <Onboarding step="connect" onStepChange={change} onFinish={vi.fn()} />,
        "Codex",
      );
      expect(button("Next").disabled).toBe(false);
      await act(async () => button("Next").click());
      expect(change).toHaveBeenCalledWith("media");
      expect(api.updateAgentDefaults).toHaveBeenCalledWith({
        model: nativeModel,
        nativeReasoningLevel: "low",
      });
    },
  );

  it.each(["Check again", "focus"])(
    "uses a selected CLI after sign-in via %s without reselecting it",
    async (completion) => {
      let runtime = {
        ...codex,
        auth: { status: "signed-out", billing: "unknown" },
      };
      api.listAgentRuntimes.mockImplementation(async () => [runtime]);
      api.loginAgentRuntime.mockResolvedValue({ command: "codex login" });
      api.updateAgentRuntime.mockImplementation(async (_id, change) => {
        runtime = { ...runtime, ...change };
        return runtime;
      });
      api.recheckAgentRuntime.mockImplementation(async () => {
        runtime = { ...runtime, auth: codex.auth };
        api.listModels.mockResolvedValue({ ...catalog, models: [nativeModel] });
        return runtime;
      });
      await showConnection(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      );
      await chooseAgent("Codex");
      expect(container.textContent).toContain("codex login");
      expect(api.updateAgentRuntime).toHaveBeenCalledExactlyOnceWith(
        "codex-cli",
        { enabled: true },
      );
      await act(async () => {
        if (completion === "focus") window.dispatchEvent(new Event("focus"));
        else button("Check again").click();
      });
      expect(api.recheckAgentRuntime).toHaveBeenCalledWith("codex-cli");
      expect(
        container.querySelector(".onboarding-selected-agent")?.textContent,
      ).toContain("Codex");
      expect(container.textContent).not.toContain("codex login");
      expect(button("Next").disabled).toBe(false);
      expect(api.updateAgentRuntime).toHaveBeenCalledOnce();
      expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    },
  );

  it.each(["enable", "sign-in"])(
    "retries a selected CLI's failed %s without reopening the choices",
    async (failure) => {
      const runtime = { ...codex, auth: { status: "signed-out" } };
      api.listAgentRuntimes.mockResolvedValue([runtime]);
      api.updateAgentRuntime.mockResolvedValue({ ...runtime, enabled: true });
      api.loginAgentRuntime.mockResolvedValue({ command: "codex login" });
      if (failure === "enable")
        api.updateAgentRuntime.mockRejectedValueOnce(
          new Error("Could not connect"),
        );
      else
        api.loginAgentRuntime.mockRejectedValueOnce(
          new Error("Could not connect"),
        );
      await showConnection(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      );
      await chooseAgent("Codex");
      expect(container.textContent).toContain("Could not connect");
      expect(container.querySelector(".onboarding-agent-options")).toBeNull();
      await act(async () => button("Sign in").click());
      expect(container.textContent).toContain("codex login");
      expect(container.textContent).not.toContain("Could not connect");
      expect(api.loginAgentRuntime).toHaveBeenCalledTimes(
        failure === "sign-in" ? 2 : 1,
      );
      expect(api.updateAgentRuntime).toHaveBeenCalledTimes(
        failure === "enable" ? 2 : 1,
      );
    },
  );

  it("keeps providers under OhMyGame and limits the model picker to the selected agent", async () => {
    const builtIn = {
      ...nativeModel,
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "chat",
      name: "Chat",
      reasoningLevels: ["off"] as const,
    };
    const models = [
      nativeModel,
      { ...nativeModel, id: "second", name: "Second native model" },
      builtIn,
    ];
    api.listAgentRuntimes.mockResolvedValue([{ ...codex, enabled: true }]);
    api.listModels.mockResolvedValue({
      ...catalog,
      models,
      defaultModel: models[1],
    });
    api.updateAgentDefaults.mockImplementation(async ({ model }) => {
      api.listModels.mockResolvedValue({
        ...catalog,
        models,
        defaultModel: model,
      });
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      false,
    );
    expect(agentButton("Codex").getAttribute("aria-pressed")).toBe("true");
    expect(
      agentButton("Codex").querySelector('[aria-label="Ready"]'),
    ).not.toBeNull();
    expect(agentButton("Codex").textContent).not.toContain("Use");
    expect(container.querySelector(".onboarding-picker")).toBeNull();
    await chooseAgent("Codex");
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(container.querySelector(".onboarding-ready")?.textContent).toContain(
      "Second native model",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(".onboarding-model-select > button")!
        .click(),
    );
    const menu = document.querySelector(".canvas-chip-menu")!;
    expect(menu.textContent).toContain("Second native model");
    expect(menu.textContent).not.toContain("Chat");
    await act(async () =>
      menu.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await chooseAgent("OhMyGame");
    expect(container.querySelector(".onboarding-picker")).not.toBeNull();
    expect(container.querySelector(".onboarding-ready")?.textContent).toContain(
      "Chat",
    );
    expect(
      container.querySelector(".onboarding-ready")?.textContent,
    ).not.toContain("Native");
    await chooseAgent("Codex");
    await act(async () => api.notifyAgentModelsChanged());
    expect(container.querySelector(".onboarding-ready")?.textContent).toContain(
      "Second native model",
    );
    await chooseAgent("OhMyGame");
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: builtIn,
      reasoningLevel: "off",
    });
  });

  it("retries a failed native default save without enabling the CLI again", async () => {
    api.listAgentRuntimes.mockResolvedValue([codex]);
    api.updateAgentRuntime.mockImplementation(async () => {
      api.listModels.mockResolvedValue({ ...catalog, models: [nativeModel] });
      api.listAgentRuntimes.mockResolvedValue([{ ...codex, enabled: true }]);
      return { ...codex, enabled: true };
    });
    api.updateAgentDefaults.mockRejectedValueOnce(
      new Error("Native default failed"),
    );
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    await chooseAgent("Codex");
    await act(async () => button("Next").click());
    expect(container.textContent).toContain("Native default failed");
    await act(async () => button("Retry").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledTimes(2);
    expect(api.updateAgentRuntime).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Native default failed");
  });

  it("requires a model from the selected agent before continuing", async () => {
    const builtIn = {
      ...nativeModel,
      provider: "openrouter",
      providerName: "OpenRouter",
    };
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [builtIn],
      defaultModel: builtIn,
    });
    api.listAgentRuntimes.mockResolvedValue([{ ...codex, installed: false }]);
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    expect(button("Next").disabled).toBe(false);
    await chooseAgent("Codex");
    expect(button("Next").disabled).toBe(true);
    expect(container.querySelector(".onboarding-ready")).toBeNull();
    expect(container.querySelector(".onboarding-picker")).toBeNull();
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await chooseAgent("OhMyGame");
    expect(button("Next").disabled).toBe(false);
  });

  it("opens the installation guide only from its explicit action and can recheck installation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const installUrl = "https://developers.openai.com/codex/cli";
    api.listAgentRuntimes.mockResolvedValue([
      {
        ...codex,
        installed: false,
        diagnostics: [
          {
            code: "not-installed",
            message: "Not installed",
            command: installUrl,
          },
        ],
      },
    ]);
    api.recheckAgentRuntime.mockImplementation(async () => {
      api.listAgentRuntimes.mockResolvedValue([codex]);
      return codex;
    });
    api.updateAgentRuntime.mockImplementation(async () => {
      const installed = { ...codex, enabled: true };
      api.listAgentRuntimes.mockResolvedValue([installed]);
      api.listModels.mockResolvedValue({ ...catalog, models: [nativeModel] });
      return installed;
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    await chooseAgent("Codex");
    expect(open).not.toHaveBeenCalled();
    expect(api.loginAgentRuntime).not.toHaveBeenCalled();
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
    expect(
      container.querySelector(".onboarding-agent-config")?.textContent,
    ).toContain("Install Codex, then check again.");
    await act(async () => button("Installation guide").click());
    expect(open).toHaveBeenCalledExactlyOnceWith(
      installUrl,
      "_blank",
      "noopener,noreferrer",
    );
    await act(async () => button("Check again").click());
    expect(api.recheckAgentRuntime).toHaveBeenCalledWith("codex-cli");
    expect(
      container.querySelector(".onboarding-agent-install-actions"),
    ).toBeNull();
    expect(api.updateAgentRuntime).toHaveBeenCalledExactlyOnceWith(
      "codex-cli",
      { enabled: true },
    );
    expect(button("Next").disabled).toBe(false);
  });

  it("polls a slow CLI catalog while retaining a usable provider model", async () => {
    vi.useFakeTimers();
    try {
      const builtIn = {
        ...nativeModel,
        provider: "openrouter",
        providerName: "OpenRouter",
        reasoningLevels: ["off"] as const,
      };
      api.listModels
        .mockResolvedValueOnce({
          ...catalog,
          models: [builtIn],
          loadingRuntimes: ["codex-cli"],
        })
        .mockResolvedValue({
          ...catalog,
          models: [builtIn, nativeModel],
          defaultModel: nativeModel,
        });
      await showConnection(
        <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      );
      expect(button("Next").disabled).toBe(false);
      expect(container.textContent).toContain("Checking coding agent models");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(
        container.querySelector(".onboarding-ready")?.textContent,
      ).toContain("OpenRouter");
      expect(container.textContent).not.toContain(
        "Checking coding agent models",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows starting without media setup or a conversation model", async () => {
    const step = vi.fn(),
      finish = vi.fn();
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={step} onFinish={finish} />,
      ),
    );
    expect(button("Start creating").disabled).toBe(false);
    expect(container.querySelector("footer")?.textContent).toBe(
      "Start creating",
    );
    expect(container.textContent).toContain("Settings → Providers & Models");
    expect(step).not.toHaveBeenCalled();
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("skipped");
  });
});

describe("optional creative tools and built-in agent", () => {
  it("labels OhMyGame as default without pretending a model is connected", async () => {
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      false,
    );
    const row = container.querySelector('[aria-label="OhMyGame"]')!;
    expect(row.textContent).toBe("OhMyGameDefault");
    expect(row.textContent).not.toContain("Enabled by default");
    expect(row.textContent).not.toContain("Uses your model providers");
    expect(row.querySelector('[role="switch"]')).toBeNull();
    expect(button("Next").disabled).toBe(true);
    expect(row.querySelector('[aria-label="Enabled"]')).not.toBeNull();
    expect(row.textContent).not.toContain("Connect model");
    await chooseAgent("OhMyGame");
    expect(
      container.querySelector(".onboarding-selected-agent")?.textContent,
    ).toContain("OhMyGame");
    expect(
      container.querySelector(".onboarding-agent-config")?.textContent,
    ).toContain("LLM providers");
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  });

  it("can return from a CLI to OhMyGame using a connected provider model", async () => {
    const builtIn = {
      provider: "openrouter",
      providerName: "OpenRouter",
      id: "chat",
      name: "Chat",
      reasoningLevels: ["off"],
    };
    api.listModels.mockResolvedValue({
      ...catalog,
      defaultModel: { provider: "codex-cli", id: "native" },
      models: [
        builtIn,
        {
          provider: "codex-cli",
          id: "native",
          providerName: "Codex",
          name: "Native",
          reasoningLevels: [],
        },
      ],
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
    );
    await chooseAgent("OhMyGame");
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    await act(async () => button("Next").click());
    expect(api.updateAgentDefaults).toHaveBeenCalledWith({
      model: builtIn,
      reasoningLevel: "off",
    });
    expect(api.updateAgentRuntime).not.toHaveBeenCalled();
    expect(
      container.querySelector(".onboarding-selected-agent")?.textContent,
    ).toContain("OhMyGame");
    expect(container.querySelector(".onboarding-picker")).not.toBeNull();
    const modelLine = container.querySelector(".onboarding-ready")!;
    expect(modelLine.textContent).toContain("Chat");
    expect(modelLine.textContent).not.toContain("Native");
  });

  it("filters creative providers by image, video, 3D and audio", async () => {
    api.listProviders.mockResolvedValue([
      {
        ...provider,
        id: "image-test",
        name: "Image provider",
        capabilities: ["image"],
      },
      {
        ...provider,
        id: "video-test",
        name: "Video provider",
        capabilities: ["video"],
      },
      { ...provider, id: "3d-test", name: "3D provider", capabilities: ["3d"] },
      {
        ...provider,
        id: "audio-test",
        name: "Audio provider",
        capabilities: ["audio"],
      },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(providerButton("Image provider", "Configure")).toBeDefined();
    for (const [tab, name] of [
      ["Video", "Video provider"],
      ["3D", "3D provider"],
      ["Audio", "Audio provider"],
    ]) {
      await act(async () => button(tab!).click());
      expect(providerButton(name!, "Configure")).toBeDefined();
      expect(
        container.querySelector('[aria-label="Image provider"]'),
      ).toBeNull();
    }
  });

  it("keeps creative setup focused on connections without loading default-model catalogs", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, configured: true, capabilities: ["image"] },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(container.querySelector(".settings-generation-defaults")).toBeNull();
    expect(
      container.querySelector(
        '[aria-label="OpenRouter"] [aria-label="Connected"]',
      ),
    ).not.toBeNull();
    expect(providerButton("OpenRouter", "Configure").textContent).toBe("");
    const modelLoads = api.listModels.mock.calls.length;
    await act(async () => api.notifyAgentModelsChanged());
    expect(api.listModels).toHaveBeenCalledTimes(modelLoads);
    expect(api.listImageModelCatalog).not.toHaveBeenCalled();
    expect(api.listVideoModelCatalog).not.toHaveBeenCalled();
    expect(api.listModel3DCatalog).not.toHaveBeenCalled();
    expect(button("Start creating").disabled).toBe(false);
  });

  it("lists all media providers without a More section", async () => {
    api.listProviders.mockResolvedValue([
      { ...provider, id: "openai", name: "OpenAI", capabilities: ["image"] },
      {
        ...provider,
        id: "other-image",
        name: "Other image provider",
        capabilities: ["image"],
      },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(providerButton("OpenAI", "Configure")).toBeDefined();
    expect(providerButton("Other image provider", "Configure")).toBeDefined();
    expect(container.textContent).not.toContain("More providers");
  });

  it("adds a custom provider inline on the media step without changing the chat model", async () => {
    api.listProviders.mockResolvedValue([]);
    api.saveCustomProvider.mockImplementation(async () => {
      api.listProviders.mockResolvedValue([
        {
          ...provider,
          id: customProvider.id,
          name: customProvider.name,
          custom: true,
          configured: true,
          capabilities: ["image"],
        },
      ]);
      return customProvider;
    });
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await openCustomProvider();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(
      container.querySelector('section[aria-label="Custom provider"]'),
    ).not.toBeNull();
    await fillCustomProvider();
    await act(async () => button("Add provider").click());
    expect(api.saveCustomProvider).toHaveBeenCalledOnce();
    expect(providerButton(customProvider.name, "Configure")).toBeDefined();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(button("Start creating").disabled).toBe(false);
  });

  it("keeps setup busy while a custom media provider is being saved", async () => {
    const save = deferred<CustomProviderDetails>();
    api.saveCustomProvider.mockReturnValue(save.promise);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await openCustomProvider();
    await fillCustomProvider();
    await act(async () => button("Add provider").click());
    expect(button("Start creating").disabled).toBe(true);
    expect(stepButton("connect").disabled).toBe(true);
    await act(async () => save.resolve(customProvider));
    expect(button("Start creating").disabled).toBe(false);
  });

  it("uses the shared authorization form and does not change the conversation model", async () => {
    const mediaProvider = { ...provider, capabilities: ["image"] };
    api.listProviders.mockResolvedValue([mediaProvider]);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    await act(async () => providerButton("OpenRouter", "Configure").click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith(
      "openrouter",
      "api_key",
    );
    await act(async () => streams[0]!.onEvent(secretPrompt("image-key")));
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(button("Start creating").disabled).toBe(false);
    api.listProviders.mockResolvedValue([
      { ...mediaProvider, configured: true, status: "connected" },
    ]);
    await event({ type: "completed" });
    expect(
      container.querySelector(
        '[aria-label="OpenRouter"] [aria-label="Connected"]',
      ),
    ).not.toBeNull();
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
    expect(api.listImageModelCatalog).not.toHaveBeenCalled();
    expect(api.listVideoModelCatalog).not.toHaveBeenCalled();
    expect(api.listModel3DCatalog).not.toHaveBeenCalled();
  });

  it("keeps media setup skippable after a provider-loading failure", async () => {
    const finish = vi.fn();
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [
        {
          provider: "codex-cli",
          providerName: "Codex",
          id: "native",
          name: "Native",
          reasoningLevels: [],
        },
      ],
    });
    api.listProviders.mockRejectedValue(
      new Error("Media providers unavailable"),
    );
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={finish} />,
      ),
    );
    expect(container.textContent).toContain("Media providers unavailable");
    expect(button("Start creating").disabled).toBe(false);
    await act(async () => button("Start creating").click());
    expect(finish).toHaveBeenCalledWith("completed");
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
  });

  it("does not mark an OpenAI chat-only connection as image-ready", async () => {
    api.listProviders.mockResolvedValue([
      {
        ...provider,
        id: "openai",
        name: "OpenAI",
        configured: true,
        languageConfigured: true,
        imageConfigured: false,
        capabilities: ["image", "language"],
      },
    ]);
    await act(async () =>
      root.render(
        <Onboarding step="media" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      ),
    );
    expect(
      container.querySelector('[aria-label="OpenAI"]')?.textContent,
    ).not.toContain("Connected");
    expect(api.listImageModelCatalog).not.toHaveBeenCalled();
  });
});

describe("onboarding interactions", () => {
  it("starts with agent choices, then collapses them into a change action without losing the model", async () => {
    const model = {
      provider: provider.id,
      id: "chat",
      name: "My model",
      providerName: provider.name,
      reasoningLevels: ["off"],
    };
    api.listModels.mockResolvedValue({
      ...catalog,
      models: [model],
      defaultModel: model,
    });
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      false,
    );
    expect(container.querySelector(".onboarding-agent-options")).not.toBeNull();
    expect(container.querySelector(".onboarding-picker")).toBeNull();
    expect(container.querySelector(".onboarding-ready")).toBeNull();
    expect(button("Next").disabled).toBe(true);
    await chooseAgent("OhMyGame");
    expect(container.querySelector(".onboarding-agent-options")).toBeNull();
    expect(
      container.querySelector(".onboarding-selected-agent")?.textContent,
    ).toContain("OhMyGame");
    expect(container.querySelector(".onboarding-ready")?.textContent).toContain(
      "My model",
    );
    expect(button("Next").disabled).toBe(false);
    await act(async () => button("Switch").click());
    expect(container.querySelector(".onboarding-picker")).toBeNull();
    expect(button("Next").disabled).toBe(true);
    await chooseAgent("OhMyGame");
    expect(container.querySelector(".onboarding-ready")?.textContent).toContain(
      "My model",
    );
    expect(api.updateAgentDefaults).not.toHaveBeenCalled();
  });

  it("maps vertical wheel movement to the agent row and releases scrolling at its edges", async () => {
    await showConnection(
      <Onboarding step="connect" onStepChange={vi.fn()} onFinish={vi.fn()} />,
      false,
    );
    const row = container.querySelector<HTMLDivElement>(
      ".onboarding-agent-options",
    )!;
    Object.defineProperties(row, {
      scrollWidth: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 400 },
    });
    const wheel = (options: WheelEventInit) => {
      const event = new WheelEvent("wheel", {
        cancelable: true,
        bubbles: true,
        ...options,
      });
      Object.defineProperties(event, {
        ctrlKey: { value: options.ctrlKey ?? false },
        shiftKey: { value: options.shiftKey ?? false },
      });
      row.dispatchEvent(event);
      return event;
    };
    expect(wheel({ deltaY: 80 }).defaultPrevented).toBe(true);
    expect(row.scrollLeft).toBe(80);
    expect(wheel({ deltaX: 60, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(wheel({ deltaY: 60, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(wheel({ deltaY: 60, shiftKey: true }).defaultPrevented).toBe(false);
    expect(row.scrollLeft).toBe(80);
    expect(wheel({ deltaY: 3, deltaMode: 1 }).defaultPrevented).toBe(true);
    expect(row.scrollLeft).toBe(128);
    row.scrollLeft = 200;
    expect(wheel({ deltaY: 60 }).defaultPrevented).toBe(false);
    row.scrollLeft = 0;
    expect(wheel({ deltaY: -60 }).defaultPrevented).toBe(false);
  });

  it.each([false, true])(
    "finishes the arrival greeting with reduced motion %s",
    async (reducedMotion) => {
      vi.useFakeTimers();
      const complete = vi.fn();
      const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
      vi.spyOn(window, "matchMedia").mockReturnValue({
        ...preference,
        matches: reducedMotion,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });
      try {
        await act(async () =>
          root.render(<OnboardingArrival onComplete={complete} />),
        );
        expect(container.querySelector("h1")?.textContent).toBe(
          "Welcome, Gamer!",
        );
        expect(complete).toHaveBeenCalledTimes(reducedMotion ? 1 : 0);
        await act(async () => vi.advanceTimersByTime(1_900));
        expect(complete).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels arrival completion when its screen is removed", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    try {
      await act(async () =>
        root.render(<OnboardingArrival onComplete={complete} />),
      );
      await act(async () => root.render(null));
      await act(async () => vi.advanceTimersByTime(2_000));
      expect(complete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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

it("shows the arrival only after saving setup and reveals the interactive studio afterwards", async () => {
  vi.doMock(path.resolve("src/renderer/home.tsx"), () => ({
    Home: ({ inert }: { inert?: boolean }) => <main inert={inert}>Studio</main>,
  }));
  vi.doMock(
    path.resolve("src/renderer/asset-canvas-quick-start.ts"),
    async (original) => ({
      ...(await original<
        typeof import("../src/renderer/asset-canvas-quick-start.js")
      >()),
      invalidateQuickStartModels: vi.fn(),
      loadQuickStartModels: vi.fn().mockResolvedValue([]),
    }),
  );
  vi.doMock(
    path.resolve("src/renderer/app-navigation.ts"),
    async (original) => ({
      ...(await original<typeof import("../src/renderer/app-navigation.js")>()),
      useAppNavigation: () => ({ route: { page: "home" }, navigate: vi.fn() }),
    }),
  );
  const { App } = await import("../src/renderer/app.js");
  api.getOnboardingState.mockResolvedValue({
    version: 1,
    status: "pending",
    step: "media",
  });
  api.updateOnboardingState.mockRejectedValueOnce(
    new Error("Setup save failed"),
  );
  await act(async () => root.render(<App />));
  await act(async () => button("Start creating").click());
  expect(container.textContent).toContain("Setup save failed");
  expect(container.querySelector(".onboarding-arrival")).toBeNull();
  vi.useFakeTimers();
  try {
    await act(async () => button("Retry").click());
    expect(container.querySelector(".onboarding-arrival h1")?.textContent).toBe(
      "Welcome, Gamer!",
    );
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(true);
    await act(async () => vi.advanceTimersByTime(1_900));
    expect(container.querySelector(".onboarding-arrival")).toBeNull();
    expect(container.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(container.textContent).toBe("Studio");
  } finally {
    vi.useRealTimers();
  }
});
