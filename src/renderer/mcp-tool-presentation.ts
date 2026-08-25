interface McpToolCall {
  server?: string;
  operation: string;
}

const MCP_SERVERS: Record<string, { name: string; brand?: "godot" }> = {
  "opengame-godot": { name: "Godot", brand: "godot" },
};
const DISPLAY_WORDS: Record<string, string> = {
  godot: "Godot",
  id: "ID",
  mcp: "MCP",
  uid: "UID",
  url: "URL",
};

export function mcpToolCall(toolName: string, args: unknown): McpToolCall | undefined {
  if (toolName !== "mcp") return undefined;
  const values = record(args);
  let server = text(values?.server);
  let operation = text(values?.tool);
  if (!operation) return undefined;
  if (!server) {
    server = Object.keys(MCP_SERVERS).find((id) => operation.startsWith(`${id}_`)) ?? "";
  }
  if (server && operation.startsWith(`${server}_`)) operation = operation.slice(server.length + 1);
  return { operation, ...(server ? { server } : {}) };
}

export function mcpToolLabel(call: McpToolCall): string {
  return `${mcpServerName(call.server)}: ${humanizeIdentifier(call.operation)}`;
}

export function mcpToolBrand(call: McpToolCall): "godot" | undefined {
  return call.server ? MCP_SERVERS[call.server]?.brand : undefined;
}

export function mcpServerName(server?: string): string {
  if (!server) return "MCP";
  return MCP_SERVERS[server]?.name ?? humanizeIdentifier(server);
}

function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Tool";
  return words.map((word, index) => {
    if (DISPLAY_WORDS[word]) return DISPLAY_WORDS[word];
    return index === 0 ? word[0].toUpperCase() + word.slice(1) : word;
  }).join(" ");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
