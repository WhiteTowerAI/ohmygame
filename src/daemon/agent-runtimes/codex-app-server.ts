import { AgentProcess, processFailure } from "./process.js";
import type { AgentUsageLimit } from "../../shared/contracts.js";
import { record } from "./driver-context.js";
import {
  AgentRuntimeCompatibilityError,
  cliProbeError,
} from "./compatibility.js";

export const CODEX_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: true,
    skill_approval: false,
  },
};

export function requireCodexPermissionProfile(
  response: { activePermissionProfile?: { id?: string } },
  profile: string,
): void {
  if (response.activePermissionProfile?.id !== profile)
    throw new AgentRuntimeCompatibilityError(
      "Codex did not activate OhMyGame's filesystem permissions. A CLI supporting named permission profiles is required. Update Codex and check again in Settings.",
      "permissions / activePermissionProfile",
    );
}

/** Checks the experimental protocol without sending a prompt or retaining a thread. */
export async function checkCodexCompatibility(
  server: CodexAppServer,
  directory: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<void> {
  const profile = "ohmygame-compatibility-probe";
  const read = await server.request<{ config?: Record<string, unknown> }>(
    "config/read",
    { cwd: directory },
    timeoutMs,
  );
  // Windows' sandbox requires `:root` read access; `:minimal` is rejected.
  // The regular conversation applies the same Windows adjustment.
  const filesystemPermissions: Record<string, unknown> =
    process.platform === "win32"
      ? { ":root": "read", ":workspace_roots": { ".": "read" } }
      : { ":minimal": "read", ":workspace_roots": { ".": "read" } };
  const config: Record<string, unknown> = {
    default_permissions: profile,
    project_root_markers: [],
    notify: [],
    "features.request_permissions_tool": true,
    "features.shell_snapshot": false,
    permissions: {
      [profile]: {
        filesystem: filesystemPermissions,
        network: { enabled: true },
      },
    },
  };
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
      approvalPolicy: CODEX_APPROVAL_POLICY,
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
export class CodexAppServer {
  readonly process: AgentProcess;
  #next = 1;
  #pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (cause: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #closed?: Error;

  constructor(
    binaryPath: string,
    cwd: string,
    env: Record<string, string>,
    private readonly handlers: {
      processDirectory?: string;
      notification?: (method: string, params: Record<string, unknown>) => void;
      request?: (
        method: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>;
      exit?: (failure: string) => void;
    } = {},
  ) {
    this.process = new AgentProcess({
      binaryPath,
      args: ["app-server"],
      cwd,
      env,
      processDirectory: handlers.processDirectory,
      onLine: (line) => this.#receive(line),
      onExit: (code, signal, stderr) => {
        this.#closed = new Error(processFailure("Codex", code, signal, stderr));
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(this.#closed);
        }
        this.#pending.clear();
        handlers.exit?.(this.#closed.message);
      },
    });
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

  request<T = Record<string, unknown>>(
    method: string,
    params: unknown,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex did not answer ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.process.write({ jsonrpc: "2.0", id, method, params });
      } catch (cause) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.process.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  stop(): Promise<void> {
    return this.process.stop();
  }

  #receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      const params = record(message.params) ?? {};
      if (id === undefined || id === null) {
        this.handlers.notification?.(message.method, params);
        return;
      }
      void (
        this.handlers.request?.(message.method, params) ??
        Promise.reject(new Error(`Unsupported request ${message.method}`))
      ).then(
        (result) => {
          if (this.process.running)
            this.process.write({ jsonrpc: "2.0", id, result });
        },
        (cause) => {
          if (this.process.running)
            this.process.write({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32000,
                message: cause instanceof Error ? cause.message : String(cause),
              },
            });
        },
      );
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = record(message.error);
    if (error)
      pending.reject(
        cliProbeError("Codex", String(error.message ?? "Codex request failed")),
      );
    else pending.resolve(message.result);
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
