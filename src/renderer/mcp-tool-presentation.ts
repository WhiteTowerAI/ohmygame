import { GODOT_MCP_SERVER_ID, type McpToolIdentity } from "../shared/mcp.js";

const MCP_SERVERS: Record<string, { name: string; brand?: "godot" }> = {
  [GODOT_MCP_SERVER_ID]: { name: "Godot", brand: "godot" },
};
const DISPLAY_WORDS: Record<string, string> = {
  godot: "Godot",
  id: "ID",
  mcp: "MCP",
  uid: "UID",
  url: "URL",
};

export function mcpToolLabel(call: McpToolIdentity): string {
  return `${mcpServerName(call.server)}: ${humanizeIdentifier(call.tool)}`;
}

export function mcpToolBrand(call: McpToolIdentity): "godot" | undefined {
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
