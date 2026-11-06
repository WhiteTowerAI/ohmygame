// A local MCP server over stdio: one JSON-RPC message per line. OhMyGame
// starts it when an agent first needs one of its tools, and lists to agents
// only the tools the manifest names.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Says back what it was given. Replace it with what the server does.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function answer(method, params) {
  if (method === "initialize")
    return { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "server", version: "0.1.0" } };
  if (method === "tools/list") return { tools };
  if (method === "tools/call" && params?.name === "echo") return { content: [{ type: "text", text: String(params.arguments?.text ?? "") }] };
  throw Object.assign(new Error(`Unknown method ${method}`), { code: -32601 });
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, method, params } = JSON.parse(line);
  // A notification has no id and gets no answer.
  if (id === undefined) continue;
  try {
    send({ id, result: answer(method, params) });
  } catch (error) {
    send({ id, error: { code: error.code ?? -32603, message: error.message } });
  }
}
