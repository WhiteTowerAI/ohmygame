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
  connectExternalAgent: vi.fn(
    async (id: string) =>
      (external = {
        ...external,
        clients: external.clients.map((client) =>
          client.id === id ? { ...client, connected: true } : client,
        ),
      }),
  ),
  disconnectExternalAgent: vi.fn(async () => external),
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
    clients: [
      { id: "claude-code", available: true, connected: false },
      { id: "codex", available: false, connected: false },
    ],
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("lets other agents use OhMyGame and connects a CLI found on this computer", async () => {
  await act(async () => root.render(<ExternalAgentsSettings />));
  expect(host.querySelector("h3")?.textContent).toBe("MCP Server");
  expect(host.querySelector(".external-agents-clients")).toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(
        'input[aria-label="Allow other agents to use OhMyGame"]',
      )!
      .click(),
  );
  expect(api.updateExternalAgentSettings).toHaveBeenCalledWith({
    enabled: true,
  });
  const clients = () => host.querySelector(".external-agents-clients")!;
  const rows = [...clients().querySelectorAll(".settings-provider-row")];
  expect(
    rows.map(
      (item) =>
        item.querySelector(".settings-provider-description")?.textContent,
    ),
  ).toEqual(["Not connected", "CLI not detected on this computer"]);
  // Codex is not installed, so it has nothing to connect.
  expect(rows[1]!.querySelector("button")).toBeNull();
  await act(async () =>
    rows[0]!.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(api.connectExternalAgent).toHaveBeenCalledWith("claude-code");
  expect(
    clients().querySelector(".settings-provider-row")!.textContent,
  ).toContain("Connected");
  expect(
    clients().querySelector(".external-agents-manual code")?.textContent,
  ).toBe('"/Users/me/Library/Application Support/OhMyGame/bin/ohmygame-mcp"');
});

it("explains that connecting needs the desktop app", async () => {
  external = { ...external, enabled: true };
  delete external.launcher;
  await act(async () => root.render(<ExternalAgentsSettings />));
  expect(host.textContent).toContain(
    "Connect agents from the OhMyGame desktop app.",
  );
  expect(host.querySelector(".external-agents-clients")).toBeNull();
});
