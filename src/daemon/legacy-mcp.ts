import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";

/** Read-only import boundary for the retired Connections configuration. */
export class LegacyMcpConfiguration {
  constructor(private readonly agentDirectory: string) {}

  async readAndBackup(): Promise<Record<string, unknown>> {
    const filePath = path.join(this.agentDirectory, "mcp.json");
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      return {};
    }
    const errors: ParseError[] = [];
    const config = parse(contents, errors, {
      allowTrailingComma: true,
    }) as unknown;
    if (errors.length || !isRecord(config))
      throw new Error(`OhMyGame Pi MCP config is invalid: ${filePath}`);
    if (config.mcpServers !== undefined && !isRecord(config.mcpServers))
      throw new Error(
        `OhMyGame Pi MCP config has an invalid mcpServers field: ${filePath}`,
      );
    await mkdir(this.agentDirectory, { recursive: true });
    try {
      await writeFile(`${filePath}.pre-plugins.bak`, contents, {
        flag: "wx",
        mode: 0o600,
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    }
    return (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
