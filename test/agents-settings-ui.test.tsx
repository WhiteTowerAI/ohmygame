// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentRuntimeStatus } from "../src/shared/agent-runtimes.js";
import type { AgentModelCatalog } from "../src/shared/contracts.js";

const agent = (
  id: AgentRuntimeStatus["id"],
  name: string,
  enabled: boolean,
): AgentRuntimeStatus => ({
  id,
  name,
  enabled,
  installed: true,
  version: "1.0.0",
  auth: { status: "signed-in", billing: "subscription" },
  isolateUserConfig: true,
  commandSandbox: "os",
  permissionMode: "standard",
  diagnostics: [],
});
let catalog: AgentModelCatalog;
const api = {
  listModels: vi.fn(async () => catalog),
  waitForRuntime: vi.fn(async () => {}),
  updateAgentRuntime: vi.fn(
    async (
      id: AgentRuntimeStatus["id"],
      change: Partial<AgentRuntimeStatus>,
    ) => ({
      ...agent(id, "Claude Code", true),
      ...change,
    }),
  ),
  listAgentRuntimes: vi.fn(async () => [
    agent("claude-code-cli", "Claude Code", true),
    agent("codex-cli", "Codex", false),
  ]),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { AgentsSettings } = await import("../src/renderer/agents-settings.js");

const gpt = {
  provider: "openai",
  providerName: "OpenAI",
  id: "gpt-5",
  name: "GPT-5",
  reasoningLevels: [],
};
const sonnet = {
  provider: "claude-code-cli",
  providerName: "Claude Code",
  id: "sonnet",
  name: "Sonnet",
  reasoningLevels: [],
};

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

async function render(
  onViewChange = vi.fn(),
  onOpenProviders = vi.fn(),
): Promise<void> {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agents" }}
        onViewChange={onViewChange}
        onOpenProviders={onOpenProviders}
      />,
    ),
  );
}
const row = (name: string) =>
  [...host.querySelectorAll(".settings-provider-row")].find(
    (item) =>
      item.querySelector(".settings-provider-name > span")?.textContent ===
      name,
  );

it("lists OhMyGame's own agent with its default model above the coding agent CLIs", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "openai", id: "gpt-5" },
    defaultReasoningLevel: "medium",
  };
  const onOpenProviders = vi.fn();
  await render(vi.fn(), onOpenProviders);
  const names = [
    ...host.querySelectorAll(".settings-provider-name > span"),
  ].map((item) => item.textContent);
  expect(names).toEqual(["OhMyGame", "Claude Code", "Codex"]);
  expect(
    row("OhMyGame")!.querySelector(".settings-provider-details"),
  ).toBeNull();
  expect(row("OhMyGame")!.querySelector("small")?.textContent).toBe("Default");
  expect(
    row("Claude Code")!.querySelector(".settings-provider-name small"),
  ).toBeNull();
  await act(async () =>
    row("OhMyGame")!
      .querySelector<HTMLButtonElement>('button[aria-label="Manage models"]')!
      .click(),
  );
  expect(onOpenProviders).toHaveBeenCalled();
});

it("marks the CLI new conversations start with and opens its settings", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "claude-code-cli", id: "sonnet" },
    defaultReasoningLevel: "medium",
  };
  const onViewChange = vi.fn();
  await render(onViewChange);
  expect(row("OhMyGame")!.querySelector("small")).toBeNull();
  expect(
    row("Claude Code")!.querySelector(".settings-provider-name small")
      ?.textContent,
  ).toBe("Default");
  await act(async () =>
    row("Codex")!
      .querySelector<HTMLButtonElement>('button[aria-label="Manage Codex"]')!
      .click(),
  );
  expect(onViewChange).toHaveBeenCalledWith({ page: "agent", id: "codex-cli" });
});

it("waits for a CLI still listing its models before marking OhMyGame as the default", async () => {
  catalog = {
    models: [gpt],
    loadingRuntimes: ["claude-code-cli"],
    defaultReasoningLevel: "medium",
  };
  await render();
  expect(row("OhMyGame")!.querySelector("small")).toBeNull();
});

it("asks for a provider when OhMyGame has no models", async () => {
  catalog = { models: [sonnet], defaultReasoningLevel: "medium" };
  await render();
  expect(row("OhMyGame")!.textContent).toContain(
    "No models yet. Connect a provider in Providers & Models.",
  );
});

it("shows a CLI's command sandbox as one row on its detail page", async () => {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "claude-code-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  const rows = [...host.querySelectorAll(".settings-provider-setting-row")].map(
    (item) => item.textContent,
  );
  expect(rows).toContain("Command sandboxOperating system");
  expect(host.querySelectorAll(".settings-detail-hint")).toHaveLength(0);
});

it("switches a CLI to full access and says what that means", async () => {
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "claude-code-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.querySelector(".coding-agent-warning")).toBeNull();
  const full = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Full access",
  )!;
  await act(async () => full.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("claude-code-cli", {
    permissionMode: "full",
  });
  expect(host.querySelector(".coding-agent-warning")?.textContent).toContain(
    "without a sandbox or asking",
  );
  expect(
    [...host.querySelectorAll(".settings-provider-setting-row")].map(
      (row) => row.textContent,
    ),
  ).toContain("Command sandboxOff, full access");
});

it("refreshes account limits when the model probe finishes after the first status read", async () => {
  catalog = { models: [gpt], defaultReasoningLevel: "medium" };
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  api.listModels.mockImplementationOnce(async () => {
    await waiting;
    return catalog;
  });
  api.listAgentRuntimes
    .mockResolvedValueOnce([agent("codex-cli", "Codex", true)])
    .mockResolvedValueOnce([
      {
        ...agent("codex-cli", "Codex", true),
        limits: [{ id: "codex/primary", usedPercent: 42, windowMinutes: 300 }],
      },
    ]);
  await render();
  expect(row("Codex")!.querySelector(".agent-usage-inline")).toBeNull();
  await act(async () => finish());
  expect(row("Codex")!.querySelector(".agent-usage-inline")?.textContent).toBe(
    "5-hour42%",
  );
});

it("shows each CLI's usage limits in its row and on its detail page", async () => {
  const limits = [
    { id: "claude/five_hour", usedPercent: 13, windowMinutes: 300 },
    { id: "claude/seven_day", usedPercent: 33, windowMinutes: 10080 },
  ];
  api.listAgentRuntimes.mockResolvedValue([
    { ...agent("claude-code-cli", "Claude Code", true), limits },
    agent("codex-cli", "Codex", false),
    agent("opencode-cli", "OpenCode", true),
  ]);
  catalog = { models: [gpt], defaultReasoningLevel: "medium" };
  await render();
  expect(
    row("Claude Code")!.querySelector(".agent-usage-inline")?.textContent,
  ).toBe("5-hour13%Weekly33%");
  expect(row("Codex")!.querySelector(".agent-usage-inline")).toBeNull();
  const detail = async (id: "claude-code-cli" | "codex-cli" | "opencode-cli") =>
    act(async () =>
      root.render(
        <AgentsSettings
          view={{ page: "agent", id }}
          onViewChange={vi.fn()}
          onOpenProviders={vi.fn()}
        />,
      ),
    );
  await detail("claude-code-cli");
  expect(host.textContent).toContain("Usage limits");
  expect(host.textContent).toContain("33% used");
  await detail("codex-cli");
  expect(host.textContent).toContain("Shown after a conversation with Codex.");
  await detail("opencode-cli");
  expect(host.textContent).not.toContain("Usage limits");
});
