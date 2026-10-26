// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAccountProfileStatus, AgentRuntimeStatus } from "../src/shared/agent-runtimes.js";
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
  listAccountProfiles: vi.fn(async (): Promise<AgentAccountProfileStatus[]> => [
    { id: "system", name: "System default", auth: { status: "signed-in", billing: "subscription" } },
    { id: "work", name: "Work", auth: { status: "signed-out", billing: "unknown" } },
  ]),
  loginAgentRuntime: vi.fn(async () => ({ command: "fixture-cli login" })),
  deleteAccountProfile: vi.fn(async (_runtime: string, _id: string) => {}),
  addAccountProfile: vi.fn(async (_runtime: string, name: string, configDirectory?: string) => ({ id: "new-account", name, configDirectory })),
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

it("keeps the detail page focused on status and configurable controls", async () => {
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
  expect(rows).toContain("StatusInstalled · v1.0.0");
  expect(rows.some((row) => /Command sandbox|Billing|Verified version/.test(row ?? ""))).toBe(false);
  expect(host.textContent).toContain(
    "Leave empty and save to find the CLI automatically.",
  );
});

it("shows the installed version and missing capability without reference metadata", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", true),
      version: "0.162.0-alpha.17.2",
      testedVersion: "0.163.0",
      diagnostics: [
        {
          code: "runtime-incompatible",
          message: "Probe details",
          capability: "permissions / activePermissionProfile",
        },
      ],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).not.toContain("Verified version");
  expect(host.textContent).toContain("0.162.0-alpha.17.2");
  expect(host.textContent).toContain("permissions / activePermissionProfile");
  expect(host.textContent).toContain("CLI incompatible");
  expect(host.textContent).not.toContain("too old");
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
  ).not.toContain("Command sandboxOff, full access");
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
    "5-hour42% used",
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
  ).toBe("5-hour13% usedWeekly33% used");
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
  expect(host.textContent).toContain("Claude Code uses your CLI configuration");
  expect(host.textContent).not.toContain("Use my own CLI configuration");
  expect(host.textContent).toContain("Usage limits");
  expect(host.textContent).toContain("33% used");
  await detail("codex-cli");
  expect(host.textContent).toContain("Codex uses your CLI configuration");
  expect(host.textContent).not.toContain("Use my own CLI configuration");
  expect(host.textContent).toContain("Shown after a conversation with Codex.");
  await detail("opencode-cli");
  expect(host.textContent).not.toContain("Usage limits");
  expect(host.textContent).toContain("uses your CLI configuration");
  expect(host.textContent).not.toContain("Use my own CLI configuration");
});

it("shows the resolved CLI source separately from an empty automatic path override", async () => {
  const binaryPath =
    "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      binaryPath,
      binarySource: "codex-app",
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>("#codex-cli-executable")!.value,
  ).toBe("");
  expect(host.textContent).toContain("Bundled with Codex");
  expect(
    host.querySelector(".coding-agent-executable-path code")?.textContent,
  ).toBe(binaryPath);
});

it("keeps an invalid manual path editable and explains how to restore automatic detection", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      installed: false,
      configuredBinaryPath: "/missing/codex",
      diagnostics: [{ code: "invalid-executable", message: "Missing" }],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(
    host.querySelector<HTMLInputElement>("#codex-cli-executable")!.value,
  ).toBe("/missing/codex");
  expect(host.textContent).toContain("Configured executable unavailable");
  expect(host.textContent).toContain(
    "clear it and save to restore automatic detection",
  );
  expect(host.textContent).not.toContain("Installation guide");
});

it("does not label a failed CLI probe as a successful installation check", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", false),
      diagnostics: [{ code: "probe-failed", message: "Failed to start" }],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("CLI check failed");
});


it.each(["claude-code-cli", "codex-cli"] as const)("uses the shared sign-in result and command controls for a named %s profile", async (id) => {
  api.listAgentRuntimes.mockResolvedValueOnce([agent(id, id === "codex-cli" ? "Codex" : "Claude Code", true)]);
  await act(async () => root.render(
    <AgentsSettings view={{ page: "agent", id }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />,
  ));
  const profile = [...host.querySelectorAll(".agent-account-profile-list .provider-model-row")].find((item) => item.querySelector("strong")?.textContent === "Work")!;
  expect(profile).toBeDefined();
  const confirm = vi.spyOn(window, "confirm");
  await act(async () => profile.querySelector<HTMLButtonElement>("button")!.click());
  expect(confirm).not.toHaveBeenCalled();
  confirm.mockRestore();
  expect(api.loginAgentRuntime).toHaveBeenCalledWith(id, "work");
  expect(host.querySelector(".coding-agent-command code")?.textContent).toBe("fixture-cli login");
  expect(host.querySelector('[aria-label="Copy command"]')).not.toBeNull();
});


it.each([undefined, "/existing/config"])("keeps account creation collapsed and uses the directory only when supplied (%s)", async (directory) => {
  api.listAgentRuntimes.mockResolvedValueOnce([agent("codex-cli", "Codex", true)]);
  await act(async () => root.render(
    <AgentsSettings view={{ page: "agent", id: "codex-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />,
  ));
  expect(host.querySelector('[aria-label="Account name"]')).toBeNull();
  expect(host.textContent).not.toContain("Sign in once per configuration");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Add account"]')!.click());
  const fill = async (label: string, value: string) => act(async () => {
    const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await fill("Account name", "Personal");
  const advanced = host.querySelector<HTMLDetailsElement>(".agent-account-profile-form details")!;
  expect(advanced.open).toBe(false);
  if (directory) {
    advanced.open = true;
    await fill("Configuration directory", directory);
  }
  await act(async () => host.querySelector<HTMLFormElement>(".agent-account-profile-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.addAccountProfile).toHaveBeenCalledWith("codex-cli", "Personal", directory);
  expect(host.querySelector('[aria-label="Account name"]')).toBeNull();
  if (directory) expect(api.loginAgentRuntime).not.toHaveBeenCalled();
  else expect(api.loginAgentRuntime).toHaveBeenCalledWith("codex-cli", "new-account");
});

it("selects the default account directly from its row", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([agent("codex-cli", "Codex", true)]);
  await act(async () => root.render(
    <AgentsSettings view={{ page: "agent", id: "codex-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />,
  ));
  const choice = host.querySelector<HTMLInputElement>('[aria-label="Use Work for new chats"]')!;
  await act(async () => choice.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("codex-cli", { defaultProfileId: "work" });
  expect(choice.checked).toBe(true);
  expect(choice.closest("label")?.textContent).toContain("Default");
});

it.each([true, false])("confirms account deletion with managed=%s and resets the selected default", async (managed) => {
  api.listAgentRuntimes.mockResolvedValueOnce([{ ...agent("codex-cli", "Codex", true), defaultProfileId: "work" }]);
  api.listAccountProfiles.mockResolvedValueOnce([
    { id: "system", name: "System default", auth: { status: "signed-in", billing: "subscription" } },
    { id: "work", name: "Work", configDirectory: "/fixture/work", managed, auth: { status: "signed-out", billing: "unknown" } },
  ]);
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "codex-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];
  expect(buttons().some((button) => button.getAttribute("aria-label") === "Delete System default account")).toBe(false);
  const remove = buttons().find((button) => button.getAttribute("aria-label") === "Delete Work account")!;
  await act(async () => remove.click());
  const confirmation = () => host.querySelector<HTMLElement>(".settings-provider-delete-confirmation")!;
  expect(confirmation().textContent).toContain(managed ? "sign-in files and native history will be removed" : "existing CLI directory and files will be kept");
  expect(api.deleteAccountProfile).not.toHaveBeenCalled();
  await act(async () => [...confirmation().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click());
  expect(confirmation()).toBeNull();
  await act(async () => remove.click());
  await act(async () => confirmation().querySelector<HTMLButtonElement>(".settings-danger-button")!.click());
  expect(api.deleteAccountProfile).toHaveBeenCalledWith("codex-cli", "work");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Use System default for new chats"]')?.checked).toBe(true);
  expect(buttons().some((button) => button.getAttribute("aria-label") === "Delete Work account")).toBe(false);
  expect(confirmation()).toBeNull();
});

it("keeps the account and displays the error when deletion is refused", async () => {
  api.deleteAccountProfile.mockRejectedValueOnce(new Error("Wait for the agent to finish"));
  await act(async () => root.render(<AgentsSettings view={{ page: "agent", id: "claude-code-cli" }} onViewChange={vi.fn()} onOpenProviders={vi.fn()} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Delete Work account"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-danger-button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Wait for the agent to finish");
  expect(host.querySelector('button[aria-label="Delete Work account"]')).not.toBeNull();
  expect(host.querySelector(".settings-provider-delete-confirmation")).not.toBeNull();
});

it("explains a Windows sandbox incompatibility instead of reporting an empty model catalog", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", true),
      diagnostics: [
        {
          code: "runtime-incompatible",
          capability: "Windows sandbox filesystem read restrictions",
          message: "Codex sandbox cannot enforce read restrictions",
        },
      ],
    },
  ]);
  await act(async () =>
    root.render(
      <AgentsSettings
        view={{ page: "agent", id: "codex-cli" }}
        onViewChange={vi.fn()}
        onOpenProviders={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).toContain("unelevated Windows sandbox");
  expect(host.textContent).toContain("Set up the elevated sandbox");
  expect(host.textContent).toContain("Windows sandbox guide");
  expect(host.textContent).not.toContain("Codex did not list its models");
});
