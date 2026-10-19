/** The daemon route external agents reach OhMyGame's tools through. */
export const EXTERNAL_MCP_PATH = "/external-mcp";

/** The public tool contract version, reported as the MCP server version. */
export const EXTERNAL_MCP_CONTRACT_VERSION = 1;

/** Absolute folders the client works in, as a JSON array; the launcher sends the client's MCP roots. */
export const EXTERNAL_MCP_ROOTS_HEADER = "x-ohmygame-roots";

export interface ExternalAgentSettings {
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
