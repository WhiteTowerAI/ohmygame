/** The daemon route external agents reach OhMyGame's tools through. */
export const EXTERNAL_MCP_PATH = "/external-mcp";

/** The public tool contract version, reported as the MCP server version. */
export const EXTERNAL_MCP_CONTRACT_VERSION = 1;

/**
 * The name clients register OhMyGame under. It differs from the `ohmygame`
 * server OhMyGame gives the coding agents it runs, so a CLI that loads both
 * never confuses one for the other.
 */
export const EXTERNAL_MCP_SERVER_NAME = "ohmygame-studio";

/** Absolute folders the client works in, as a JSON array; the launcher sends the client's MCP roots. */
export const EXTERNAL_MCP_ROOTS_HEADER = "x-ohmygame-roots";

/** Set for the coding agents OhMyGame runs, so the launcher they may inherit does not connect back. */
export const EXTERNAL_MCP_DISABLED_ENV = "OHMYGAME_EXTERNAL_MCP_DISABLED";

/** Clients OhMyGame can connect with their own CLI. Others are configured by hand. */
export const EXTERNAL_AGENT_CLIENT_IDS = ["claude-code", "codex"] as const;
export type ExternalAgentClientId = (typeof EXTERNAL_AGENT_CLIENT_IDS)[number];

/** How a client starts the launcher; it is absent when the daemon runs without the desktop app. */
export interface ExternalMcpLauncher {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ExternalAgentClientState {
  id: ExternalAgentClientId;
  /** The CLI was found on this computer. */
  available: boolean;
  /** OhMyGame added itself to the CLI's user configuration. */
  connected: boolean;
}

/** A client that used the MCP server since OhMyGame started. */
export interface ExternalMcpClientActivity {
  /** The name the client gives itself, such as `claude-code`. */
  name: string;
  lastUsedAt: string;
  /** Tool calls it made. */
  calls: number;
  /** It still has an open session. */
  active: boolean;
}

export interface ExternalAgentSettings {
  enabled: boolean;
  launcher?: ExternalMcpLauncher;
  clients: ExternalAgentClientState[];
  recent?: ExternalMcpClientActivity[];
}

/** The `mcp add` arguments a client's CLI takes to start OhMyGame's launcher. */
export function externalClientAddArguments(
  id: ExternalAgentClientId,
  launcher: ExternalMcpLauncher,
): string[] {
  const env = Object.entries(launcher.env).map(
    ([name, value]) => `${name}=${value}`,
  );
  const command = ["--", launcher.command, ...launcher.args];
  return id === "claude-code"
    ? [
        "mcp",
        "add",
        "--scope",
        "user",
        EXTERNAL_MCP_SERVER_NAME,
        ...env.flatMap((item) => ["-e", item]),
        ...command,
      ]
    : [
        "mcp",
        "add",
        EXTERNAL_MCP_SERVER_NAME,
        ...env.flatMap((item) => ["--env", item]),
        ...command,
      ];
}

export interface UpdateExternalAgentSettings {
  enabled: boolean;
}

/** Written to `<dataDirectory>/external-mcp/endpoint.json` while the daemon accepts external agents. */
export interface ExternalMcpEndpoint {
  version: 1;
  url: string;
  token: string;
  contractVersion: number;
  pid: number;
}

/** Written to `<dataDirectory>/external-mcp/tools.json`, so the launcher can list tools while OhMyGame is closed. */
export interface ExternalMcpCatalog {
  version: 1;
  contractVersion: number;
  instructions: string;
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}
