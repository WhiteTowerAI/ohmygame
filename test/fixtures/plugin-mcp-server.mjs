import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === "initialize")
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "plugin-fixture", version: "1.0.0" },
    };
  else if (message.method === "tools/list")
    result = {
      tools: [
        {
          name: "echo",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    };
  else if (message.method === "tools/call")
    result = {
      content: [{ type: "text", text: String(message.params.arguments.value) }],
    };
  else if (message.method === "resources/list") result = { resources: [] };
  else if (message.method === "resources/templates/list")
    result = { resourceTemplates: [] };
  else if (message.method === "prompts/list") result = { prompts: [] };
  else result = {};
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n",
  );
});
