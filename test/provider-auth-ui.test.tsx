// @vitest-environment happy-dom
import path from "node:path";
import i18next from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ModelAuthEvent,
  ModelAuthPrompt,
  ProviderSummary,
} from "../src/shared/contracts.js";

let onEvent: ((event: ModelAuthEvent) => void) | undefined;
const api = {
  startModelProviderLogin: vi.fn(async () => "operation"),
  cancelModelAuth: vi.fn(async () => {}),
  respondToModelAuth: vi.fn(async () => {}),
  getOpenAIEndpointSettings: vi.fn(async () => ({
    baseUrl: "https://api.openai.com/v1",
  })),
  getOpenAIImageSettings: vi.fn(async () => ({
    mode: "connection",
    baseUrl: "https://api.openai.com/v1",
    configured: false,
    connectionAvailable: false,
    models: [],
  })),
  subscribeToModelAuth: vi.fn(
    (_id: string, handlers: { onEvent: (event: ModelAuthEvent) => void }) => {
      onEvent = handlers.onEvent;
      return () => {};
    },
  ),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ModelsSettings } = await import("../src/renderer/models-settings.js");
const initialLanguage = i18next.language;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  onEvent = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await i18next.changeLanguage(initialLanguage);
  vi.unstubAllGlobals();
});

const openai: ProviderSummary = {
  id: "openai",
  name: "OpenAI",
  configured: false,
  status: "not_configured",
  capabilities: ["language"],
  methods: [
    { type: "oauth", label: "Sign in with ChatGPT" },
    { type: "api_key", label: "OpenAI API key" },
  ],
};

async function render(provider = openai) {
  await act(async () =>
    root.render(
      <ModelsSettings
        view={{ page: "provider", provider }}
        onViewChange={() => {}}
      />,
    ),
  );
}

async function prompt(value: ModelAuthPrompt) {
  await act(async () =>
    onEvent!({
      id: 1,
      operationId: "operation",
      type: "prompt",
      promptId: "prompt",
      prompt: value,
    }),
  );
}

it.each([
  [
    "en",
    "Sign in with ChatGPT",
    "OpenAI API key",
    "Enter OpenAI API key",
    "Paste your OpenAI API key",
  ],
  [
    "zh-CN",
    "使用 ChatGPT 登录",
    "OpenAI API 密钥",
    "输入 OpenAI API 密钥",
    "粘贴你的 OpenAI API 密钥",
  ],
])(
  "localizes first-time API key connection in %s",
  async (locale, oauth, key, label, placeholder) => {
    await i18next.changeLanguage(locale);
    await render();
    const choices = [
      ...host.querySelectorAll<HTMLButtonElement>(
        ".settings-form-actions button",
      ),
    ];
    expect(choices.map((choice) => choice.textContent)).toEqual([oauth, key]);
    await act(async () => choices[1]!.click());
    expect(api.startModelProviderLogin).toHaveBeenCalledWith(
      "openai",
      "api_key",
    );
    await prompt({ type: "secret", message: "Enter OpenAI API key" });
    const input = host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    expect(input.closest("label")?.querySelector("span")?.textContent).toBe(
      label,
    );
    expect(input.placeholder).toBe(placeholder);
    expect(input.autocomplete).toBe("new-password");
  },
);

it.each(["en", "zh-CN"])(
  "preserves custom OAuth instructions in %s",
  async (locale) => {
    await i18next.changeLanguage(locale);
    await render({
      ...openai,
      id: "anthropic",
      name: "Anthropic",
      methods: [
        { type: "oauth", label: "Anthropic (Claude Pro/Max)" },
        openai.methods[1]!,
      ],
    });
    const choice = host.querySelector<HTMLButtonElement>(
      ".settings-method-row",
    )!;
    expect(choice.querySelector("strong")?.textContent).toBe(
      "Anthropic (Claude Pro/Max)",
    );
    await act(async () => choice.click());
    await prompt({
      type: "manual_code",
      message: "Paste the one-time code from your account",
      placeholder: "code#state",
    });
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.closest("label")?.textContent).toBe(
      "Paste the one-time code from your account",
    );
    expect(input.placeholder).toBe("code#state");
  },
);

it("offers first-time chat credentials and an endpoint for an image-only OpenAI connection", async () => {
  await i18next.changeLanguage("en");
  await render({
    ...openai,
    configured: true,
    languageConfigured: false,
    imageConfigured: true,
  });
  const choice = [
    ...host.querySelectorAll<HTMLButtonElement>(
      ".settings-form-actions button",
    ),
  ].find((button) => button.textContent === "OpenAI API key")!;
  await act(async () => choice.click());
  await prompt({ type: "secret", message: "Enter OpenAI API key" });
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(input.closest("label")?.textContent).toBe("Enter OpenAI API key");
  expect(input.placeholder).toBe("Paste your OpenAI API key");
  expect(
    host.querySelector<HTMLInputElement>("#model-provider-base-url")?.value,
  ).toBe("https://api.openai.com/v1");
});

it.each(["en", "zh-CN"])(
  "preserves multi-step cloud credential prompts in %s",
  async (locale) => {
    await i18next.changeLanguage(locale);
    await render({
      ...openai,
      id: "amazon-bedrock",
      name: "Amazon Bedrock",
      methods: [{ type: "api_key", label: "AWS credentials or bearer token" }],
    });
    await prompt({
      type: "select",
      message: "Select Amazon Bedrock authentication method:",
      options: [
        { id: "bearer", label: "Bearer token" },
        { id: "profile", label: "AWS profile" },
      ],
    });
    expect(host.querySelector("label")?.textContent).toContain(
      "Select Amazon Bedrock authentication method:",
    );
    expect(
      [...host.querySelectorAll("option")].map((option) => option.textContent),
    ).toEqual(["Bearer token", "AWS profile"]);
    await prompt({
      type: "secret",
      message: "Enter Amazon Bedrock bearer token",
      placeholder: "AWS bearer token",
    });
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.closest("label")?.textContent).toBe(
      "Enter Amazon Bedrock bearer token",
    );
    expect(input.placeholder).toBe("AWS bearer token");
  },
);
