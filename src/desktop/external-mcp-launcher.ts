import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EXTERNAL_MCP_CONTRACT_VERSION,
  EXTERNAL_MCP_ROOTS_HEADER,
  EXTERNAL_MCP_SERVER_NAME,
  type ExternalMcpCatalog,
  type ExternalMcpEndpoint,
} from "../shared/external-mcp.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const START_TIMEOUT_MS = 30_000;
const START_POLL_MS = 500;

/** Only these tool calls can be replayed when a response is lost. Unknown tools are treated as writes. */
const READ_ONLY_TOOLS = new Set([
  "list_projects",
  "get_project",
  "get_job",
  "wait_job",
  "canvas_check",
  "playable_check",
]);
const PROJECT_INDEPENDENT_TOOLS = new Set([
  "list_projects",
  "open_project",
  "get_job",
  "wait_job",
  "cancel_job",
]);

interface Connection {
  url: string;
  token: string;
  session: string;
  projectId?: string;
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export type Message = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

export interface LauncherOptions {
  dataDirectory: string;
  /** Starts the OhMyGame app; undefined when the launcher cannot. */
  startApp?: () => void;
  write: (message: Message) => void;
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  isAlive?: (pid: number) => boolean;
  startTimeoutMs?: number;
}

/**
 * The stdio MCP server Claude Code, Codex and other clients start. It answers
 * `initialize` and `tools/list` itself, from the list the daemon saved, so a
 * client opening a session in any folder does not start OhMyGame; the first
 * tool call starts the app if needed and forwards to the daemon's
 * `/external-mcp`. See docs/external-agents.md.
 */
export class ExternalMcpLauncher {
  readonly #options: LauncherOptions;
  readonly #directory: string;
  readonly #inFlight = new Map<string | number, AbortController>();
  #initialize: Record<string, unknown> = {};
  #rootsSupported = false;
  #roots: string[] = [];
  #rootsRequest = 0;
  #connection?: Connection;
  #connecting?: Promise<Connection>;
  /** Canonical ID returned by a successful explicit selection, independent of the daemon session. */
  #projectId?: string;

  constructor(options: LauncherOptions) {
    this.#options = options;
    this.#directory = path.join(options.dataDirectory, "external-mcp");
  }

  /** Handles one message from the client. Requests are answered concurrently. */
  async receive(message: Message): Promise<void> {
    if (message.method === undefined) return this.#clientAnswer(message);
    if (message.id === undefined || message.id === null)
      return this.#notification(message);
    const id = message.id;
    try {
      const result = await this.#request(message);
      if (result !== undefined)
        this.#options.write({ jsonrpc: "2.0", id, result });
    } catch (cause) {
      const code =
        typeof (cause as { code?: unknown }).code === "number"
          ? (cause as { code: number }).code
          : -32603;
      this.#options.write({
        jsonrpc: "2.0",
        id,
        error: { code, message: errorMessage(cause) },
      });
    } finally {
      this.#inFlight.delete(id);
    }
  }

  /** Ends the daemon session when the client goes away. */
  async close(): Promise<void> {
    for (const controller of this.#inFlight.values()) controller.abort();
    const connection = this.#connection;
    if (!connection) return;
    await this.#fetch(connection.url, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "mcp-session-id": connection.session,
      },
      signal: AbortSignal.timeout(2_000),
    }).catch(() => undefined);
  }

  async #request(message: Message): Promise<unknown> {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize": {
        this.#initialize = params;
        const capabilities = (params.capabilities ?? {}) as Record<
          string,
          unknown
        >;
        this.#rootsSupported = !!capabilities.roots;
        const catalog = await this.#catalog();
        return {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: EXTERNAL_MCP_SERVER_NAME,
            version: String(EXTERNAL_MCP_CONTRACT_VERSION),
          },
          ...(catalog?.instructions
            ? { instructions: catalog.instructions }
            : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list": {
        const catalog = await this.#catalog();
        if (catalog) return { tools: catalog.tools };
        // Never connected from a running app yet: ask it, if it is open.
        return (
          (await this.#forward(message, false).catch(() => undefined)) ?? {
            tools: [],
          }
        );
      }
      case "tools/call":
        try {
          return await this.#forward(message, true);
        } catch (cause) {
          // A tool error the agent can read and relay, rather than a protocol failure.
          return {
            content: [{ type: "text", text: errorMessage(cause) }],
            isError: true,
          };
        }
      case "resources/list":
        return { resources: [] };
      case "prompts/list":
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), {
          code: -32601,
        });
    }
  }

  #notification(message: Message): void {
    if (
      message.method === "notifications/initialized" ||
      message.method === "notifications/roots/list_changed"
    ) {
      if (this.#rootsSupported) this.#requestRoots();
    } else if (message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      if (typeof id === "string" || typeof id === "number")
        this.#inFlight.get(id)?.abort();
    }
  }

  #requestRoots(): void {
    this.#options.write({
      jsonrpc: "2.0",
      id: `ohmygame-roots-${++this.#rootsRequest}`,
      method: "roots/list",
    });
  }

  #clientAnswer(message: Message): void {
    if (
      typeof message.id !== "string" ||
      !message.id.startsWith("ohmygame-roots-")
    )
      return;
    const roots = (
      message.result as { roots?: Array<{ uri?: unknown }> } | undefined
    )?.roots;
    if (Array.isArray(roots))
      this.#roots = roots
        .map((root) => root.uri)
        .filter((uri): uri is string => typeof uri === "string");
  }

  /** The client's folders: its MCP roots, else the project folder it reports or the folder it started us in. */
  #folders(): string[] {
    if (this.#roots.length) return this.#roots;
    const environment = this.#options.environment ?? process.env;
    return [
      environment.CLAUDE_PROJECT_DIR,
      this.#options.cwd ?? process.cwd(),
    ].filter((folder): folder is string => !!folder);
  }

  async #catalog(): Promise<ExternalMcpCatalog | undefined> {
    try {
      const catalog = JSON.parse(
        await readFile(path.join(this.#directory, "tools.json"), "utf8"),
      ) as ExternalMcpCatalog;
      return catalog.version === 1 && Array.isArray(catalog.tools)
        ? catalog
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #forward(message: Message, start: boolean): Promise<unknown> {
    const controller = new AbortController();
    if (message.id !== undefined && message.id !== null)
      this.#inFlight.set(message.id, controller);
    const tool =
      message.method === "tools/call"
        ? String(message.params?.name ?? "")
        : undefined;
    for (let attempt = 0; ; attempt++) {
      let connection: Connection | undefined;
      let dispatched = false;
      try {
        connection = await this.#connect(start);
        if (
          this.#projectId &&
          connection.projectId !== this.#projectId &&
          tool &&
          !PROJECT_INDEPENDENT_TOOLS.has(tool)
        ) {
          const restored = (await this.#rpc(
            connection,
            {
              jsonrpc: "2.0",
              id: 0,
              method: "tools/call",
              params: {
                name: "open_project",
                arguments: { project: this.#projectId },
              },
            },
            controller.signal,
          )) as ToolResult;
          // Keep the selection so a later call cannot silently fall back to the cwd project.
          if (restored.isError) return restored;
          connection.projectId = this.#projectId;
        }
        dispatched = true;
        const result = await this.#rpc(connection, message, controller.signal);
        if (tool === "open_project" && !(result as ToolResult).isError) {
          const text = (result as ToolResult).content?.find(
            (item) => item.type === "text",
          )?.text;
          const project = JSON.parse(text ?? "{}") as { id?: unknown };
          if (typeof project.id !== "string" || !project.id)
            throw new Error("OhMyGame returned no selected project ID");
          this.#projectId = connection.projectId = project.id;
        }
        return result;
      } catch (cause) {
        if (cause instanceof UnavailableError || controller.signal.aborted)
          throw cause;
        if (this.#connection === connection) this.#connection = undefined;
        // 401/404 reject the request before execution. Any other failure after
        // dispatch may mean a paid generation or edit already happened.
        if (
          dispatched &&
          tool &&
          !READ_ONLY_TOOLS.has(tool) &&
          !(cause instanceof SessionExpiredError)
        )
          throw new Error(
            `OhMyGame's response to ${tool} was lost or failed (${errorMessage(cause)}). Execution status is unknown; the call was not automatically retried. Check the project before starting it again.`,
          );
        if (attempt === 0) continue;
        throw new Error(
          `Could not reach OhMyGame (${errorMessage(cause)}). ${NOT_RUNNING}`,
        );
      }
    }
  }

  async #rpc(
    connection: Connection,
    message: Message,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#post(connection, message, signal);
    if (response.status === 401 || response.status === 404)
      throw new SessionExpiredError(`OhMyGame answered ${response.status}`);
    if (!response.ok)
      throw new Error(
        `OhMyGame answered ${response.status}: ${await response.text()}`,
      );
    const answer = (await response.json()) as Message;
    if (answer.error) throw new Error(errorMessage(answer.error));
    return answer.result;
  }

  #connect(start: boolean): Promise<Connection> {
    if (this.#connection) return Promise.resolve(this.#connection);
    this.#connecting ??= (async () => {
      try {
        const endpoint = await this.#endpoint(start);
        const response = await this.#post(
          { ...endpoint, session: "" },
          {
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              ...this.#initialize,
              protocolVersion: MCP_PROTOCOL_VERSION,
            },
          },
        );
        const session = response.headers.get("mcp-session-id");
        if (!response.ok || !session)
          throw new Error(
            `OhMyGame refused the connection (${response.status})`,
          );
        this.#connection = { ...endpoint, session };
        return this.#connection;
      } finally {
        this.#connecting = undefined;
      }
    })();
    return this.#connecting;
  }

  /** The running daemon's endpoint, starting OhMyGame when it is closed. */
  async #endpoint(start: boolean): Promise<{ url: string; token: string }> {
    const current = await this.#liveEndpoint();
    if (current) return current;
    if (!(await this.#enabled())) throw new UnavailableError(TURNED_OFF);
    if (!start) throw new UnavailableError(NOT_RUNNING);
    // An app that is starting or restarting its daemon is waited for, never started twice.
    if (!(await this.#appRunning())) {
      if (!this.#options.startApp) throw new UnavailableError(NOT_RUNNING);
      this.#options.startApp();
    }
    const deadline =
      Date.now() + (this.#options.startTimeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
      const started = await this.#liveEndpoint();
      if (started) return started;
    }
    throw new UnavailableError(`OhMyGame could not be started. ${NOT_RUNNING}`);
  }

  async #appRunning(): Promise<boolean> {
    try {
      const app = JSON.parse(
        await readFile(path.join(this.#directory, "app.json"), "utf8"),
      ) as { pid?: unknown };
      return (
        typeof app.pid === "number" &&
        (this.#options.isAlive ?? isAlive)(app.pid)
      );
    } catch {
      return false;
    }
  }

  async #liveEndpoint(): Promise<{ url: string; token: string } | undefined> {
    try {
      const endpoint = JSON.parse(
        await readFile(path.join(this.#directory, "endpoint.json"), "utf8"),
      ) as ExternalMcpEndpoint;
      if (endpoint.version !== 1 || !endpoint.url || !endpoint.token)
        return undefined;
      // A daemon that crashed leaves its file behind.
      if (!(this.#options.isAlive ?? isAlive)(endpoint.pid)) return undefined;
      return { url: endpoint.url, token: endpoint.token };
    } catch {
      return undefined;
    }
  }

  async #enabled(): Promise<boolean> {
    try {
      const settings = JSON.parse(
        await readFile(path.join(this.#directory, "settings.json"), "utf8"),
      ) as { enabled?: unknown };
      return settings.enabled === true;
    } catch {
      return false;
    }
  }

  #post(
    connection: { url: string; token: string; session: string },
    message: Message,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.#fetch(connection.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(connection.session ? { "mcp-session-id": connection.session } : {}),
        [EXTERNAL_MCP_ROOTS_HEADER]: JSON.stringify(this.#folders()),
      },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    });
  }

  #fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.#options.fetch ?? fetch)(url, init);
  }
}

/**
 * The command that starts OhMyGame. A packaged macOS app is opened through
 * LaunchServices: started directly by an agent that runs in a macOS sandbox,
 * such as Codex, it inherits that sandbox and crashes at launch.
 */
export function appStartCommand(
  executable: string,
  appPath?: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin" && !appPath) {
    // macOS paths stay POSIX when the platform is simulated on Windows.
    // <name>.app/Contents/MacOS/<name>
    const bundle = path.posix.resolve(executable, "../../..");
    if (bundle.endsWith(".app"))
      return { command: "/usr/bin/open", args: [bundle] };
  }
  return { command: executable, args: appPath ? [appPath] : [] };
}

const TURNED_OFF =
  "OhMyGame is not accepting other agents. Open OhMyGame and turn on Settings → MCP Server → Allow other agents to use OhMyGame.";
const NOT_RUNNING = "Open the OhMyGame app and try again.";

/** OhMyGame is off or closed; retrying the request would not help. */
class UnavailableError extends Error {}

/** Authentication/session rejection happens before any tool can execute. */
class SessionExpiredError extends Error {}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (
    cause &&
    typeof cause === "object" &&
    typeof (cause as { message?: unknown }).message === "string"
  )
    return (cause as { message: string }).message;
  return String(cause);
}
