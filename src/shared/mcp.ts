export interface McpToolIdentity {
  server?: string;
  tool: string;
}

export const GODOT_MCP_SERVER_ID = "ohmygame-godot";
const KNOWN_MCP_SERVERS = [GODOT_MCP_SERVER_ID];

export function parseMcpToolIdentity(toolName: string, args: unknown): McpToolIdentity | undefined {
  if (toolName !== "mcp" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const values = args as Record<string, unknown>;
  let server = typeof values.server === "string" ? values.server.trim() : "";
  let tool = mcpOperation(values, server);
  if (!server) {
    server = KNOWN_MCP_SERVERS.find((id) => tool.startsWith(`${id}_`)) ?? "";
  }
  if (server && tool.startsWith(`${server}_`)) tool = tool.slice(server.length + 1);
  return { tool, ...(server ? { server } : {}) };
}

export function mcpToolInput(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const values = args as Record<string, unknown>;
  if (values.tool !== undefined || values.action !== undefined) return values.args;
  const input = Object.fromEntries(
    ["connect", "describe", "instructions", "search"]
      .filter((key) => values[key] !== undefined)
      .map((key) => [key, values[key]]),
  );
  return Object.keys(input).length > 0 ? input : undefined;
}

function mcpOperation(values: Record<string, unknown>, server: string): string {
  const action = stringValue(values.action);
  if (action) return action;
  const tool = stringValue(values.tool);
  if (tool) return tool;
  if (stringValue(values.connect)) return "connect";
  const described = stringValue(values.describe);
  if (described) return `describe_${stripServerPrefix(described, server)}`;
  if (stringValue(values.instructions)) return "get_instructions";
  if (stringValue(values.search)) return "search_tools";
  return server ? "list_tools" : "status";
}

function stripServerPrefix(value: string, server: string): string {
  return server && value.startsWith(`${server}_`) ? value.slice(server.length + 1) : value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
