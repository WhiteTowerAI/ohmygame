// @vitest-environment happy-dom
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExternalAgentSettings } from "../src/shared/external-mcp.js";

let external: ExternalAgentSettings;
const api = {
  getExternalAgentSettings: vi.fn(async () => external),
  updateExternalAgentSettings: vi.fn(
    async ({ enabled }: { enabled: boolean }) =>
      (external = { ...external, enabled }),
  ),
};
vi.doMock(path.resolve("src/renderer/api.ts"), async () => ({
  ...(await vi.importActual(path.resolve("src/renderer/api.ts"))),
  ...api,
}));
const { ExternalAgentsSettings } =
  await import("../src/renderer/external-agents-settings.js");

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  external = {
    enabled: false,
    launcher: {
      command:
        "/Users/me/Library/Application Support/OhMyGame/bin/ohmygame-mcp",
      args: [],
      env: {},
    },
    skillDirectory: "/Applications/OhMyGame.app/Contents/Resources/skills/ohmygame-studio",
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lets other agents use OhMyGame and shows how to add it to each client", async () => {
  await act(async () => root.render(<ExternalAgentsSettings />));
  expect(host.querySelector(".ui-code-block")).toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="MCP Server"]',
      )!
      .click(),
  );
  expect(api.updateExternalAgentSettings).toHaveBeenCalledWith({
    enabled: true,
  });
  const snippets = [...host.querySelectorAll(".ui-code-block")].map((block) => [
    block.querySelector(".ui-code-block-head span")?.textContent,
    block.querySelector("code")?.textContent,
  ]);
  expect(snippets).toEqual([
    ["Claude Code", 'claude mcp add --scope user ohmygame-studio -- "/Users/me/Library/Application Support/OhMyGame/bin/ohmygame-mcp"'],
    ["Codex", 'codex mcp add ohmygame-studio -- "/Users/me/Library/Application Support/OhMyGame/bin/ohmygame-mcp"'],
    ["DeepSeek Harness and other MCP clients", '"/Users/me/Library/Application Support/OhMyGame/bin/ohmygame-mcp"'],
    ["Skill (optional) · copy into ~/.claude/skills or ~/.agents/skills", "/Applications/OhMyGame.app/Contents/Resources/skills/ohmygame-studio"],
  ]);
});

it("shows the launcher's environment apart from its command, which a Windows shell could not run inline", async () => {
  external = { ...external, enabled: true, launcher: { command: "C:\\Program Files\\OhMyGame\\OhMyGame.exe", args: ["mcp.js"], env: { ELECTRON_RUN_AS_NODE: "1" } } };
  await act(async () => root.render(<ExternalAgentsSettings />));
  const blocks = [...host.querySelectorAll(".ui-code-block")].map((block) => block.querySelector("code")?.textContent);
  expect(blocks).toContain('"C:\\Program Files\\OhMyGame\\OhMyGame.exe" mcp.js');
  expect(blocks).toContain("ELECTRON_RUN_AS_NODE=1");
});

it("lists the clients that used the server since OhMyGame started", async () => {
  external = {
    ...external,
    enabled: true,
    recent: [
      { name: "claude-code", lastUsedAt: new Date(Date.now() - 3 * 60_000).toISOString(), calls: 12, active: true },
      { name: "deepseek-harness", lastUsedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), calls: 1, active: false },
    ],
  };
  await act(async () => root.render(<ExternalAgentsSettings />));
  const rows = [...host.querySelectorAll(".settings-group")].find((group) => group.textContent?.includes("Recent connections"))!.querySelectorAll(".settings-row");
  expect([...rows].map((row) => row.textContent)).toEqual([
    "Claude Code3 minutes ago · 12 tool callsOnline",
    "deepseek-harness2 days ago · 1 tool callOffline",
  ]);
});

it("says when the server is off", async () => {
  await act(async () => root.render(<ExternalAgentsSettings />));
  expect(host.textContent).toContain("MCP server is off");
});

it("explains that connecting needs the desktop app", async () => {
  external = { ...external, enabled: true };
  delete external.launcher;
  await act(async () => root.render(<ExternalAgentsSettings />));
  expect(host.textContent).toContain(
    "Connect agents from the OhMyGame desktop app.",
  );
  expect(host.querySelector(".ui-code-block")).toBeNull();
});
