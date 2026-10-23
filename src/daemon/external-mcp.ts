import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ProjectState } from "../shared/contracts.js";
import {
  EXTERNAL_MCP_CONTRACT_VERSION,
  EXTERNAL_MCP_SERVER_NAME,
  type ExternalMcpCatalog,
  type ExternalMcpEndpoint,
} from "../shared/external-mcp.js";
import { matchesBearerToken } from "./access.js";
import type { NativeToolResult } from "./agent-runtimes/native-session.js";
import { ToolBridge, type BridgeTool } from "./agent-runtimes/tool-bridge.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Project tools external agents may call. Their names and schemas are the public contract. */
export const EXTERNAL_PROJECT_TOOLS = [
  "generate_image",
  "generate_video",
  "generate_3d_asset",
  "animate_3d_asset",
  "generate_speech",
  "generate_sound_effect",
  "generate_music",
  "canvas_check",
  "canvas_initialize",
  "generate_canvas_media",
  "game_use",
  "playable_add_node",
  "playable_check",
] as const;

/** Tools that call a media provider and may take minutes; they run as jobs that outlive the request. */
const JOB_TOOLS = new Set<string>([
  "generate_image",
  "generate_video",
  "generate_3d_asset",
  "animate_3d_asset",
  "generate_speech",
  "generate_sound_effect",
  "generate_music",
  "generate_canvas_media",
]);

/** Why a public tool can be missing from a project's tools. */
const UNAVAILABLE_HINTS: Record<string, string> = {
  game_use:
    "It needs the OhMyGame desktop app and a project with a game preview.",
  playable_add_node: "It needs an Interactive Story project.",
  playable_check: "It needs an Interactive Story project.",
};

/** Below Codex's default 60-second MCP tool timeout. */
const DEFAULT_WAIT_MS = 45_000;
const SESSION_IDLE_MS = 6 * 60 * 60_000;
const FINISHED_JOB_RETENTION_MS = 6 * 60 * 60_000;

const INSTRUCTIONS = [
  "OhMyGame's tools for game projects: image, video, 3D and audio generation with the person's configured providers, the Design and Asset Canvas, and playtesting the game in a real window.",
  "Every tool except list_projects and open_project acts on one OhMyGame project. Working in a project folder selects it; otherwise call list_projects and open_project.",
  "Generation tools return their result when it is ready within about 45 seconds; otherwise they return a jobId. Call wait_job with it until the job finishes, and do not start the same generation again.",
  "Generated files are saved in the project workspace and its asset library; results name each file's workspace-relative path. Read them with your own file tools.",
].join("\n");

const OWN_TOOLS: BridgeTool[] = [
  {
    name: "list_projects",
    description:
      "List OhMyGame projects with their ID, name, type and workspace folder, and which one this session uses.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "open_project",
    description:
      "Use an OhMyGame project for the rest of this session, chosen by its ID or by a folder inside its workspace.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          minLength: 1,
          maxLength: 4_096,
          description: "Project ID or absolute workspace path",
        },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "get_project",
    description:
      "Describe the project this session uses: ID, name, type and workspace folder.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_job",
    description:
      "Report a generation job's status, with its result once finished, without waiting.",
    inputSchema: jobSchema(),
  },
  {
    name: "wait_job",
    description:
      "Wait for a generation job to finish and return its result. Returns the status again if it is still running after the wait.",
    inputSchema: jobSchema({
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        maximum: 45,
        description: "How long to wait; defaults to 45",
      },
    }),
  },
  {
    name: "cancel_job",
    description:
      "Cancel a running generation job. A provider may still charge for work it already started.",
    inputSchema: jobSchema(),
  },
];

interface StoredSettings {
  version: 1;
  enabled: boolean;
}

interface Session {
  id: string;
  projectId?: string;
  /** Chosen with open_project; roots no longer change it. */
  explicit: boolean;
  usedAt: number;
}

type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

interface Job {
  id: string;
  tool: string;
  projectId: string;
  status: JobStatus;
  controller: AbortController;
  done: Promise<void>;
  outcome?: { result: NativeToolResult; isError: boolean };
  finishedAt?: number;
}

export interface ExternalMcpRequest {
  authorization: string | undefined;
  sessionId: string | undefined;
  roots: string | undefined;
  body: unknown;
  signal?: AbortSignal;
}

export interface ExternalMcpAnswer {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ExternalMcpOptions {
  dataDirectory: string;
  projects: () => ProjectState[];
  /** The project's tools for one external session; the session keeps its playtest windows. */
  tools: (project: ProjectState, sessionId: string) => ToolDefinition[];
  /** Every public project tool, for listing before a project is chosen. */
  catalog: () => ToolDefinition[];
  /** A session ended or moved to another project. */
  release?: (projectId: string, sessionId: string) => Promise<void> | void;
  waitMs?: number;
  now?: () => number;
}

/**
 * OhMyGame as an MCP server for agents outside the app (Claude Code, Codex,
 * DeepSeek Harness). See docs/external-agents.md. The token lives only as long
 * as the daemon and is published to the launcher in `endpoint.json`.
 */
export class ExternalMcpService {
  readonly #options: ExternalMcpOptions;
  readonly #directory: string;
  readonly #sessions = new Map<string, Session>();
  readonly #jobs = new Map<string, Job>();
  #enabled = false;
  #token?: string;
  #url?: string;
  #publishing: Promise<void> = Promise.resolve();

  constructor(options: ExternalMcpOptions) {
    this.#options = options;
    this.#directory = path.join(options.dataDirectory, "external-mcp");
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(
        await readFile(this.#settingsPath, "utf8"),
      ) as Partial<StoredSettings>;
      this.#enabled = value.version === 1 && value.enabled === true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    await this.#write(this.#settingsPath, {
      version: 1,
      enabled,
    } satisfies StoredSettings);
    await this.#publish();
  }

  /** The daemon accepts connections at `url`; publishes the endpoint when enabled. */
  async listening(url: string): Promise<void> {
    this.#url = url;
    await this.#publish();
  }

  async close(): Promise<void> {
    this.#url = undefined;
    await this.#publish();
    for (const job of this.#jobs.values()) job.controller.abort();
  }

  async handle(request: ExternalMcpRequest): Promise<ExternalMcpAnswer> {
    if (!this.#token || !matchesBearerToken(request.authorization, this.#token))
      return {
        status: 401,
        body: { error: "Unknown or revoked OhMyGame token" },
      };
    this.#prune();
    const messages = Array.isArray(request.body)
      ? request.body
      : [request.body];
    const initializing = messages.some(
      (message) => method(message) === "initialize",
    );
    let session: Session | undefined;
    if (initializing) {
      session = { id: randomUUID(), explicit: false, usedAt: this.#now() };
      this.#sessions.set(session.id, session);
    } else {
      if (!request.sessionId)
        return {
          status: 400,
          body: { error: "Mcp-Session-Id header is required" },
        };
      session = this.#sessions.get(request.sessionId);
      if (!session)
        return {
          status: 404,
          body: { error: "Session not found; initialize again" },
        };
    }
    session.usedAt = this.#now();
    await this.#bindRoots(session, request.roots);
    const answers: unknown[] = [];
    for (const message of messages) {
      const answer = await this.#answer(session, message, request.signal);
      if (answer) answers.push(answer);
    }
    const headers = { "mcp-session-id": session.id };
    if (!answers.length) return { status: 202, headers };
    return {
      status: 200,
      headers,
      body: Array.isArray(request.body) ? answers : answers[0],
    };
  }

  /** Ends a session the client closed with DELETE. */
  async end(
    authorization: string | undefined,
    sessionId: string | undefined,
  ): Promise<number> {
    if (!this.#token || !matchesBearerToken(authorization, this.#token))
      return 401;
    const session = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (!session) return 404;
    await this.#endSession(session);
    return 204;
  }

  get #settingsPath(): string {
    return path.join(this.#directory, "settings.json");
  }

  get #endpointPath(): string {
    return path.join(this.#directory, "endpoint.json");
  }

  get #catalogPath(): string {
    return path.join(this.#directory, "tools.json");
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /** Enabling and the daemon starting to listen may overlap; one at a time keeps the file and token in step. */
  #publish(): Promise<void> {
    const next = this.#publishing.then(() => this.#publishNow());
    this.#publishing = next.catch(() => {});
    return next;
  }

  async #publishNow(): Promise<void> {
    if (!this.#enabled || !this.#url) return this.#revoke();
    if (this.#token) return;
    // The launcher lists these while OhMyGame is closed, so a client starting does not start the app.
    await this.#write(this.#catalogPath, {
      version: 1,
      contractVersion: EXTERNAL_MCP_CONTRACT_VERSION,
      instructions: INSTRUCTIONS,
      tools: this.tools(),
    } satisfies ExternalMcpCatalog);
    this.#token = randomBytes(32).toString("base64url");
    await this.#write(this.#endpointPath, {
      version: 1,
      url: this.#url,
      token: this.#token,
      contractVersion: EXTERNAL_MCP_CONTRACT_VERSION,
      pid: process.pid,
    } satisfies ExternalMcpEndpoint);
  }

  /** Turning the feature off or closing the daemon ends every session; running jobs keep going. */
  async #revoke(): Promise<void> {
    this.#token = undefined;
    await rm(this.#endpointPath, { force: true });
    await Promise.allSettled(
      [...this.#sessions.values()].map((session) => this.#endSession(session)),
    );
  }

  async #write(file: string, value: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async #endSession(session: Session): Promise<void> {
    this.#sessions.delete(session.id);
    if (session.projectId)
      await this.#options.release?.(session.projectId, session.id);
  }

  #prune(): void {
    const now = this.#now();
    for (const session of this.#sessions.values())
      if (now - session.usedAt > SESSION_IDLE_MS)
        void this.#endSession(session);
    for (const job of this.#jobs.values())
      if (
        job.finishedAt !== undefined &&
        now - job.finishedAt > FINISHED_JOB_RETENTION_MS
      )
        this.#jobs.delete(job.id);
  }

  async #bind(session: Session, projectId: string | undefined): Promise<void> {
    if (session.projectId === projectId) return;
    if (session.projectId)
      await this.#options.release?.(session.projectId, session.id);
    session.projectId = projectId;
  }

  async #bindRoots(
    session: Session,
    header: string | undefined,
  ): Promise<void> {
    if (session.explicit || !header) return;
    let roots: unknown;
    try {
      roots = JSON.parse(header);
    } catch {
      return;
    }
    if (!Array.isArray(roots)) return;
    for (const root of roots) {
      const project =
        typeof root === "string" ? await this.#projectAt(root) : undefined;
      if (project) return this.#bind(session, project.id);
    }
  }

  /** The project whose workspace contains `location`, an absolute path or file URL. */
  async #projectAt(location: string): Promise<ProjectState | undefined> {
    let target: string;
    try {
      target = await realpath(
        location.startsWith("file:") ? fileURLToPath(location) : location,
      );
    } catch {
      return undefined;
    }
    for (const project of this.#options.projects()) {
      const workspace = await realpath(project.workspacePath).catch(
        () => undefined,
      );
      if (!workspace) continue;
      const relative = path.relative(workspace, target);
      if (!relative.startsWith("..") && !path.isAbsolute(relative))
        return project;
    }
    return undefined;
  }

  #project(session: Session): ProjectState | undefined {
    return session.projectId
      ? this.#options
          .projects()
          .find((project) => project.id === session.projectId)
      : undefined;
  }

  async #answer(
    session: Session,
    message: unknown,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const request =
      message && typeof message === "object"
        ? (message as { id?: unknown; method?: unknown; params?: unknown })
        : {};
    if (request.id === undefined || request.id === null) return undefined;
    const id = request.id;
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: EXTERNAL_MCP_SERVER_NAME,
              version: String(EXTERNAL_MCP_CONTRACT_VERSION),
            },
            instructions: INSTRUCTIONS,
          },
        };
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: this.tools() } };
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const outcome = await this.#call(
          session,
          name,
          params.arguments,
          `${session.id}:${String(id)}`,
          signal,
        );
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: outcome.result.content,
            ...(outcome.isError ? { isError: true } : {}),
          },
        };
      }
      case "resources/list":
        return { jsonrpc: "2.0", id, result: { resources: [] } };
      case "prompts/list":
        return { jsonrpc: "2.0", id, result: { prompts: [] } };
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${String(request.method)}`,
          },
        };
    }
  }

  /** The public tool list: the same for every session, whichever project it uses. */
  tools(): BridgeTool[] {
    const catalog = new ToolBridge(publicTools(this.#options.catalog())).list(
      "all",
    );
    return [...OWN_TOOLS, ...catalog.map(({ _meta: _, ...tool }) => tool)];
  }

  async #call(
    session: Session,
    name: string,
    args: unknown,
    callId: string,
    signal?: AbortSignal,
  ): Promise<{ result: NativeToolResult; isError: boolean }> {
    const input =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    switch (name) {
      case "list_projects":
        return json({
          projects: this.#options.projects().map((project) => ({
            ...describe(project),
            current: project.id === session.projectId,
          })),
        });
      case "open_project": {
        const value = typeof input.project === "string" ? input.project : "";
        const project =
          this.#options
            .projects()
            .find((candidate) => candidate.id === value) ??
          (path.isAbsolute(value) || value.startsWith("file:")
            ? await this.#projectAt(value)
            : undefined);
        if (!project)
          return failure(
            `No OhMyGame project has the ID or contains the folder ${value}. Call list_projects to see them.`,
          );
        session.explicit = true;
        await this.#bind(session, project.id);
        return json(describe(project));
      }
      case "get_project": {
        const project = this.#project(session);
        return project ? json(describe(project)) : failure(noProject());
      }
      case "get_job":
      case "wait_job":
      case "cancel_job":
        return this.#jobCall(name, input);
    }
    if (!(EXTERNAL_PROJECT_TOOLS as readonly string[]).includes(name))
      return failure(`Tool ${name} is not available`);
    const project = this.#project(session);
    if (!project) return failure(noProject());
    const tools = publicTools(this.#options.tools(project, session.id));
    if (!tools.some((tool) => tool.name === name))
      return failure(
        `Tool ${name} is not available for project ${project.name} (${project.type}). ${UNAVAILABLE_HINTS[name] ?? ""}`.trim(),
      );
    const bridge = new ToolBridge(tools);
    if (!JOB_TOOLS.has(name)) return bridge.call(name, input, callId, signal);
    // A job keeps running when the request ends: a provider may already be charging for it.
    const controller = new AbortController();
    const job: Job = {
      id: randomUUID(),
      tool: name,
      projectId: project.id,
      status: "running",
      controller,
      done: Promise.resolve(),
    };
    job.done = bridge
      .call(name, input, callId, controller.signal)
      .then((outcome) => {
        job.outcome = outcome;
        if (job.status === "running")
          job.status = outcome.isError ? "failed" : "succeeded";
        job.finishedAt = this.#now();
      });
    this.#jobs.set(job.id, job);
    return this.#settle(job, this.#options.waitMs ?? DEFAULT_WAIT_MS);
  }

  async #jobCall(
    name: "get_job" | "wait_job" | "cancel_job",
    input: Record<string, unknown>,
  ) {
    const job =
      typeof input.jobId === "string" ? this.#jobs.get(input.jobId) : undefined;
    if (!job)
      return failure(
        "Generation job not found. Jobs end when OhMyGame closes.",
      );
    if (name === "cancel_job" && job.status === "running") {
      job.status = "cancelled";
      job.finishedAt = this.#now();
      job.controller.abort();
    }
    if (name !== "wait_job") return this.#settle(job, 0);
    const seconds =
      typeof input.timeoutSeconds === "number"
        ? Math.min(Math.max(input.timeoutSeconds, 1), 45)
        : undefined;
    return this.#settle(
      job,
      seconds !== undefined
        ? seconds * 1_000
        : (this.#options.waitMs ?? DEFAULT_WAIT_MS),
    );
  }

  async #settle(
    job: Job,
    waitMs: number,
  ): Promise<{ result: NativeToolResult; isError: boolean }> {
    if (job.status === "running" && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs))),
      ]);
      clearTimeout(timer);
    }
    if (job.status === "running")
      return {
        result: {
          content: [
            {
              type: "text",
              text: `${job.tool} is still running as job ${job.id}. Call wait_job with {"jobId":"${job.id}"} to wait for the result.`,
            },
          ],
        },
        isError: false,
      };
    if (job.status === "cancelled")
      return failure(`Job ${job.id} was cancelled`);
    return job.outcome ?? failure(`Job ${job.id} ended without a result`);
  }
}

function publicTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((tool) =>
    (EXTERNAL_PROJECT_TOOLS as readonly string[]).includes(tool.name),
  );
}

function describe(project: ProjectState) {
  return {
    id: project.id,
    name: project.name,
    type: project.type,
    workspacePath: project.workspacePath,
  };
}

function method(message: unknown): unknown {
  return message && typeof message === "object"
    ? (message as { method?: unknown }).method
    : undefined;
}

function jobSchema(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      jobId: {
        type: "string",
        minLength: 1,
        description: "The jobId a generation tool returned",
      },
      ...extra,
    },
    required: ["jobId"],
    additionalProperties: false,
  };
}

function noProject(): string {
  return "No OhMyGame project is selected. Work in a project folder, or call list_projects and open_project.";
}

function json(value: unknown): { result: NativeToolResult; isError: boolean } {
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    isError: false,
  };
}

function failure(text: string): { result: NativeToolResult; isError: boolean } {
  return { result: { content: [{ type: "text", text }] }, isError: true };
}
