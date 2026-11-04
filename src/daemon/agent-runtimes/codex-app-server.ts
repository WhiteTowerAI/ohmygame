import { JsonRpcProcess, type JsonRpcHandlers } from "./json-rpc-process.js";
import type { AgentUsageLimit } from "../../shared/contracts.js";
import { record } from "./driver-context.js";
import { AgentRuntimeCompatibilityError } from "./compatibility.js";

export function requireCodexPermissionProfile(
  response: { activePermissionProfile?: { id?: string } },
  profile: string,
): void {
  if (response.activePermissionProfile?.id !== profile)
    throw new AgentRuntimeCompatibilityError(
      `Codex did not activate its ${profile} permission profile. A CLI supporting named permission profiles is required. Update Codex and check again in Settings.`,
      "permissions / activePermissionProfile",
    );
}

/** Checks the experimental protocol without sending a prompt or retaining a thread. */
export async function checkCodexCompatibility(
  server: CodexAppServer,
  directory: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  const profile = ":read-only";
  const read = await server.request<{ config?: Record<string, unknown> }>(
    "config/read",
    { cwd: directory },
    timeoutMs,
  );
  const config: Record<string, unknown> = { notify: [] };
  // A compatibility probe never starts the person's external MCP servers.
  for (const name of Object.keys(record(read.config?.mcp_servers) ?? {}))
    config[`mcp_servers.${name}.enabled`] = false;
  const response = await server.request<{
    thread?: { id?: string };
    activePermissionProfile?: { id?: string };
  }>(
    "thread/start",
    {
      cwd: directory,
      ephemeral: true,
      approvalPolicy: "never",
      permissions: profile,
      config,
      dynamicTools: [
        {
          type: "function",
          name: "ohmygame_compatibility_probe",
          description: "Compatibility fixture. No turn will be submitted.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
    timeoutMs,
  );
  requireCodexPermissionProfile(response, profile);
  if (!response.thread?.id)
    throw new Error("Codex did not start a probe thread");
}

const REQUEST_TIMEOUT_MS = 60_000;
export const CODEX_CLIENT = {
  name: "ohmygame",
  title: "OhMyGame",
  version: "1",
};

/** A JSON-RPC connection to `codex app-server` over its stdio, one message per line each way. */
export class CodexAppServer extends JsonRpcProcess {
  constructor(
    binaryPath: string,
    cwd: string,
    env: Record<string, string>,
    handlers: JsonRpcHandlers = {},
  ) {
    super(binaryPath, ["app-server"], cwd, env, "Codex", handlers);
  }

  async initialize(timeoutMs = REQUEST_TIMEOUT_MS): Promise<void> {
    await this.request(
      "initialize",
      {
        clientInfo: CODEX_CLIENT,
        capabilities: { experimentalApi: true },
      },
      timeoutMs,
    );
    this.notify("initialized");
  }
}

/** The account's quota windows from a rate-limit read or update. */
export function codexLimits(value: unknown): AgentUsageLimit[] {
  const data = record(value);
  const buckets = record(data?.rateLimitsByLimitId) ?? {
    codex: data?.rateLimits,
  };
  const limits: AgentUsageLimit[] = [];
  for (const [bucket, raw] of Object.entries(buckets)) {
    const windows = record(raw);
    for (const window of ["primary", "secondary"]) {
      const item = record(windows?.[window]);
      if (typeof item?.usedPercent !== "number") continue;
      limits.push({
        id: `${bucket}/${window}`,
        usedPercent: Math.max(0, Math.min(100, item.usedPercent)),
        ...(typeof item.windowDurationMins === "number"
          ? { windowMinutes: item.windowDurationMins }
          : {}),
        ...(typeof item.resetsAt === "number"
          ? { resetsAt: item.resetsAt }
          : {}),
      });
    }
  }
  return limits;
}
