import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequestDetails,
} from "../../shared/agent-runtimes.js";
import type {
  NativeDriver,
  NativeToolResult,
  NativeTurnInput,
  NativeTurnOutcome,
  NativeTurnSink,
} from "./native-session.js";
import { AgentProcess, processFailure } from "./process.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";
import {
  decideApproval,
  piToolCall,
  textResult,
  type DriverContext,
} from "./driver-context.js";
import { stageSkills } from "./skills.js";

const START_TIMEOUT_MS = 30_000;

interface OpenCodeServer {
  process: AgentProcess;
  url: string;
  auth: string;
  events: AbortController;
}

interface OpenCodeTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  resolve: (outcome: NativeTurnOutcome) => void;
  /** Parts already reported, by part id. */
  parts: Map<
    string,
    { kind: "text" | "reasoning"; length: number; done: boolean }
  >;
  tools: Set<string>;
  busy: boolean;
  error?: string;
}

/**
 * OpenCode through `opencode serve`, one server per conversation on a
 * loopback port with a password of its own. Messages go to the session's
 * prompt endpoint, everything that happens comes back on its event stream,
 * and permission requests are answered on the server. OhMyGame's tools are
 * a remote MCP server on the daemon whose token only works while a turn of
 * this conversation runs.
 */
export class OpenCodeDriver implements NativeDriver {
  #server?: OpenCodeServer;
  #starting?: Promise<OpenCodeServer>;
  #sessionId?: string;
  #turn?: OpenCodeTurn;
  #bridge?: { url: string; token: string; revoke: () => void };
  #userMessages = new Set<string>();
  /** What bridged OhMyGame tools returned, by tool and arguments: OpenCode's record of the call has only MCP's text. */
  #bridged = new Map<
    string,
    Array<{ result: NativeToolResult; isError: boolean }>
  >();

  constructor(private readonly context: DriverContext) {
    this.#sessionId = context.resume;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    let sessionId: string;
    try {
      await this.#start();
      sessionId = await this.#session(sink);
    } catch (cause) {
      return {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        busy: false,
      };
      this.#turn = turn;
      this.#prompt(sessionId, input).catch((cause) => {
        if (this.#turn !== turn) return;
        this.#turn = undefined;
        resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
  }

  async steer(input: NativeTurnInput): Promise<boolean> {
    if (!this.#turn || !this.#sessionId) return false;
    // OpenCode takes a prompt sent while it is busy at the next step of the running turn.
    await this.#prompt(this.#sessionId, input);
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.#sessionId || !this.#server) return;
    await this.#api("POST", `/session/${this.#sessionId}/abort`).catch(
      () => {},
    );
  }

  async compact(sink: NativeTurnSink, signal: AbortSignal): Promise<void> {
    await this.#start();
    const sessionId = await this.#session(sink);
    sink.compaction("start");
    const [providerID, modelID] = splitModel(this.context.model);
    const outcome = await new Promise<NativeTurnOutcome>((resolve) => {
      const turn: OpenCodeTurn = {
        sink,
        signal,
        resolve,
        parts: new Map(),
        tools: new Set(),
        busy: true,
      };
      this.#turn = turn;
      this.#api("POST", `/session/${sessionId}/summarize`, {
        providerID,
        modelID,
      }).catch((cause) => {
        if (this.#turn !== turn) return;
        this.#turn = undefined;
        resolve({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    sink.compaction(
      "end",
      outcome.status === "failed" ? { error: outcome.error } : {},
    );
    if (outcome.status === "failed") throw new Error(outcome.error);
  }

  reset(): void {
    this.#sessionId = undefined;
  }

  dispose(): void {
    const turn = this.#turn;
    this.#turn = undefined;
    turn?.resolve({ status: "aborted" });
    this.#bridge?.revoke();
    this.#bridge = undefined;
    this.#server?.events.abort();
    void this.#server?.process.stop();
    this.#server = undefined;
  }

  /** Whether a turn of this conversation is running, which is when its tool token works. */
  get active(): boolean {
    return Boolean(this.#turn);
  }

  async #prompt(sessionId: string, input: NativeTurnInput): Promise<void> {
    const [providerID, modelID] = splitModel(this.context.model);
    await this.#api("POST", `/session/${sessionId}/prompt_async`, {
      model: { providerID, modelID },
      ...(this.context.reasoningLevel && this.context.reasoningLevel !== "off"
        ? { variant: this.context.reasoningLevel }
        : {}),
      agent: input.readOnly ? "plan" : "build",
      system: this.context.instructions,
      parts: [
        { type: "text", text: input.text },
        ...input.images.map((image, index) => ({
          type: "file",
          mime: image.mimeType,
          filename: `image-${index + 1}`,
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
    });
  }

  async #session(sink: NativeTurnSink): Promise<string> {
    if (this.#sessionId) {
      try {
        await this.#api("GET", `/session/${this.#sessionId}`);
        sink.nativeSession(this.#sessionId);
        return this.#sessionId;
      } catch {
        this.#sessionId = undefined;
      }
    }
    const created = (await this.#api("POST", "/session", {
      title: "OhMyGame",
    })) as { id?: unknown };
    if (typeof created.id !== "string")
      throw new Error("OpenCode did not start a session");
    this.#sessionId = created.id;
    sink.nativeSession(created.id);
    return created.id;
  }

  async #start(): Promise<OpenCodeServer> {
    if (this.#server?.process.running) return this.#server;
    return (this.#starting ??= (async () => {
      try {
        const password = randomBytes(24).toString("base64url");
        this.#bridge ??= await this.context.httpBridge?.({
          active: () => Boolean(this.#turn),
          observe: (call, outcome) => {
            const key = bridgedKey(call.name, call.args);
            this.#bridged.set(key, [
              ...(this.#bridged.get(key) ?? []),
              outcome,
            ]);
          },
        });
        const env = {
          ...this.context.env,
          ...(await this.#environment()),
          OPENCODE_SERVER_PASSWORD: password,
        };
        let listening: (url: string) => void = () => {};
        const url = new Promise<string>((resolve) => {
          listening = resolve;
        });
        const child = new AgentProcess({
          binaryPath: this.context.binaryPath,
          args: [
            "serve",
            ...(this.context.isolateUserConfig ? ["--pure"] : []),
            "--hostname",
            "127.0.0.1",
            "--port",
            "0",
          ],
          cwd: this.context.workspacePath,
          env,
          onLine: (line) => {
            const match = line.match(
              /listening on (http:\/\/127\.0\.0\.1:\d+)/,
            );
            if (match?.[1]) listening(match[1]);
          },
          onExit: (code, signal, stderr) =>
            this.#exited(
              child,
              processFailure("OpenCode", code, signal, stderr),
            ),
        });
        const address = await Promise.race([
          url,
          child.exited().then(() => undefined),
          new Promise<undefined>((resolve) =>
            setTimeout(resolve, START_TIMEOUT_MS),
          ),
        ]);
        if (!address) {
          await child.stop();
          throw new Error(
            processFailure(
              "OpenCode",
              child.child.exitCode,
              child.child.signalCode,
              child.stderr || "did not start its server",
            ),
          );
        }
        const events = new AbortController();
        const server = {
          process: child,
          url: address,
          auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          events,
        };
        this.#server = server;
        void this.#listen(server);
        return server;
      } finally {
        this.#starting = undefined;
      }
    })());
  }

  /** OpenCode's configuration for this conversation, passed in its environment and never written to the workspace. */
  async #environment(): Promise<Record<string, string>> {
    const { context } = this;
    const skills = path.join(context.privateDirectory, "opencode-skills");
    const staged = context.skillDirectories.length
      ? await stageSkills(context.skillDirectories, skills)
      : [];
    const config = {
      autoupdate: false,
      share: "disabled",
      snapshot: false,
      permission: {
        edit: "allow",
        read: "allow",
        glob: "allow",
        grep: "allow",
        list: "allow",
        webfetch: "allow",
        // Commands are allowed and judged by OhMyGame when OpenCode asks; it asks for these.
        bash: {
          "*": "allow",
          "sudo *": "ask",
          "git push*": "ask",
          "npm publish*": "ask",
          "rm -rf /*": "ask",
          "rm -rf ~*": "ask",
        },
        external_directory: "ask",
      },
      ...(staged.length ? { skills: { paths: [skills] } } : {}),
      ...(this.#bridge
        ? {
            mcp: {
              [BRIDGE_SERVER_NAME]: {
                type: "remote",
                url: this.#bridge.url,
                enabled: true,
                oauth: false,
                headers: { Authorization: `Bearer ${this.#bridge.token}` },
              },
            },
          }
        : {}),
    };
    const env: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
    };
    if (context.isolateUserConfig) {
      // A configuration folder of the session's own keeps the person's global settings, plugins and agents out; sign-ins live elsewhere.
      const config = path.join(context.privateDirectory, "opencode-config");
      await mkdir(path.join(config, "opencode"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.join(config, "opencode", "opencode.json"), "{}\n", {
        mode: 0o600,
      });
      Object.assign(env, {
        XDG_CONFIG_HOME: config,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      });
    }
    return env;
  }

  async #api(method: string, route: string, body?: unknown): Promise<unknown> {
    const server = this.#server;
    if (!server) throw new Error("OpenCode is not running");
    const response = await fetch(`${server.url}${route}`, {
      method,
      headers: {
        authorization: server.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `OpenCode refused ${route}: ${text.slice(0, 500) || response.status}`,
      );
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async #listen(server: OpenCodeServer): Promise<void> {
    try {
      const response = await fetch(`${server.url}/event`, {
        headers: { authorization: server.auth },
        signal: server.events.signal,
      });
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          try {
            this.#event(
              JSON.parse(data) as {
                type?: string;
                properties?: Record<string, unknown>;
              },
            );
          } catch {
            /* An event that cannot be read is skipped. */
          }
        }
      }
    } catch {
      // The stream ends with the server; the process exit reports why.
    }
  }

  #event(event: { type?: string; properties?: Record<string, unknown> }): void {
    const turn = this.#turn;
    const properties = event.properties ?? {};
    if (
      !turn ||
      (typeof properties.sessionID === "string" &&
        properties.sessionID !== this.#sessionId)
    )
      return;
    const sink = turn.sink;
    switch (event.type) {
      case "session.status": {
        const status = record(properties.status)?.type;
        if (status === "busy") turn.busy = true;
        return;
      }
      case "message.part.delta": {
        const partID = String(properties.partID ?? "");
        const part = turn.parts.get(partID);
        if (
          !part ||
          part.done ||
          properties.field !== "text" ||
          typeof properties.delta !== "string"
        )
          return;
        part.length += properties.delta.length;
        if (part.kind === "text") sink.text(partID, properties.delta);
        else sink.thinking(partID, properties.delta);
        return;
      }
      case "message.part.updated":
        this.#part(turn, record(properties.part) ?? {});
        return;
      case "message.updated": {
        const info = record(properties.info);
        if (info?.role === "user" && typeof info.id === "string")
          this.#userMessages.add(info.id);
        if (info?.role !== "assistant") return;
        const tokens = record(info.tokens);
        if (tokens) {
          const cache = record(tokens.cache);
          sink.usage(
            {
              input: number(tokens.input),
              output: number(tokens.output),
              cacheRead: number(cache?.read),
              cacheWrite: number(cache?.write),
            },
            undefined,
            number(tokens.input) + number(cache?.read) + number(cache?.write) ||
              undefined,
          );
        }
        const error = record(info.error);
        if (error && record(error.data)?.message !== undefined)
          turn.error = String(record(error.data)?.message);
        else if (error)
          turn.error = String(error.name ?? "OpenCode reported an error");
        return;
      }
      case "permission.asked":
        void this.#permission(turn, properties);
        return;
      case "session.compacted":
        return;
      case "session.error": {
        const error = record(properties.error);
        turn.error = String(
          record(error?.data)?.message ??
            error?.name ??
            "OpenCode reported an error",
        );
        return;
      }
      case "session.idle": {
        if (!turn.busy && !turn.parts.size && !turn.tools.size && !turn.error)
          return;
        this.#turn = undefined;
        if (turn.signal.aborted) turn.resolve({ status: "aborted" });
        else if (turn.error && !/aborted/i.test(turn.error))
          turn.resolve({ status: "failed", error: turn.error });
        else turn.resolve({ status: "completed" });
        return;
      }
      default:
        return;
    }
  }

  #part(turn: OpenCodeTurn, part: Record<string, unknown>): void {
    const id = typeof part.id === "string" ? part.id : undefined;
    if (!id) return;
    const sink = turn.sink;
    if (part.type === "text" || part.type === "reasoning") {
      if (part.synthetic === true) return;
      const kind = part.type === "text" ? "text" : "reasoning";
      const text = typeof part.text === "string" ? part.text : "";
      let state = turn.parts.get(id);
      if (!state) {
        // A user message's own text comes back too; only the agent's parts belong to the turn.
        if (part.messageID && this.#userMessages.has(String(part.messageID)))
          return;
        state = { kind, length: 0, done: false };
        turn.parts.set(id, state);
      }
      if (state.done) return;
      if (text.length > state.length) {
        const delta = text.slice(state.length);
        state.length = text.length;
        if (kind === "text") sink.text(id, delta);
        else sink.thinking(id, delta);
      }
      if (record(part.time)?.end !== undefined) {
        state.done = true;
        if (kind === "text") sink.textDone(id, text);
        else sink.thinkingDone(id, text);
      }
      return;
    }
    if (part.type === "tool" && typeof part.callID === "string") {
      const state = record(part.state) ?? {};
      const callId = part.callID;
      // A pending call is still receiving its arguments.
      if (state.status === "pending") return;
      if (!turn.tools.has(callId)) {
        turn.tools.add(callId);
        const call = openCodeToolCall(
          String(part.tool ?? "tool"),
          record(state.input) ?? {},
        );
        sink.toolCall(callId, call.name, call.args);
      }
      if (state.status === "running") {
        sink.toolStarted(callId);
        return;
      }
      if (state.status !== "completed" && state.status !== "error") return;
      const tool = String(part.tool ?? "");
      const bridged = tool.startsWith(`${BRIDGE_SERVER_NAME}_`)
        ? this.#takeBridged(
            tool.slice(BRIDGE_SERVER_NAME.length + 1),
            state.input,
          )
        : undefined;
      if (bridged) sink.toolResult(callId, bridged.result, bridged.isError);
      else if (state.status === "completed")
        sink.toolResult(
          callId,
          textResult(typeof state.output === "string" ? state.output : ""),
          false,
        );
      else
        sink.toolResult(
          callId,
          textResult(
            typeof state.error === "string" ? state.error : "Tool failed",
          ),
          true,
        );
    }
  }

  #takeBridged(
    name: string,
    args: unknown,
  ): { result: NativeToolResult; isError: boolean } | undefined {
    const key = bridgedKey(name, args);
    const queue = this.#bridged.get(key);
    const outcome = queue?.shift();
    if (queue && !queue.length) this.#bridged.delete(key);
    return outcome;
  }

  async #permission(
    turn: OpenCodeTurn,
    request: Record<string, unknown>,
  ): Promise<void> {
    const id = String(request.id ?? "");
    const permission = String(request.permission ?? "");
    const patterns = Array.isArray(request.patterns)
      ? request.patterns.map(String)
      : [];
    const metadata = record(request.metadata) ?? {};
    const command =
      typeof metadata.command === "string"
        ? metadata.command
        : permission === "bash"
          ? patterns.join(" ")
          : undefined;
    const file =
      typeof metadata.filepath === "string"
        ? metadata.filepath
        : typeof metadata.filePath === "string"
          ? metadata.filePath
          : permission === "external_directory" || permission === "edit"
            ? patterns[0]
            : undefined;
    const details: ApprovalRequestDetails = {
      kind: command !== undefined ? "command" : file ? "file" : "other",
      tool: permission || "tool",
      ...(command !== undefined ? { command } : {}),
      ...(file ? { path: file } : {}),
      canAllowSession:
        Array.isArray(request.always) && request.always.length > 0,
    };
    const callId =
      typeof record(request.tool)?.callID === "string"
        ? String(record(request.tool)!.callID)
        : undefined;
    let decision: ApprovalDecision;
    try {
      decision = await decideApproval(details, this.context, turn.sink, {
        ...(callId ? { callId } : {}),
        signal: turn.signal,
      });
    } catch {
      decision = "deny";
    }
    await this.#api("POST", `/permission/${id}/reply`, {
      reply:
        decision === "allow"
          ? "once"
          : decision === "allow-session"
            ? "always"
            : "reject",
    }).catch(() => {});
  }

  #exited(child: AgentProcess, failure: string): void {
    if (this.#server?.process !== child) return;
    this.#server.events.abort();
    this.#server = undefined;
    const turn = this.#turn;
    this.#turn = undefined;
    turn?.resolve(
      turn.signal.aborted
        ? { status: "aborted" }
        : { status: "failed", error: failure },
    );
  }
}

/** OpenCode names models `provider/model`; the provider comes first, the rest is the model. */
export function splitModel(model: string): [string, string] {
  const index = model.indexOf("/");
  return index < 0
    ? ["opencode", model]
    : [model.slice(0, index), model.slice(index + 1)];
}

/** OhMyGame's tools by their own names; OpenCode's file and shell tools by Pi's. */
export function openCodeToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; args: Record<string, unknown> } {
  const prefix = `${BRIDGE_SERVER_NAME}_`;
  if (name.startsWith(prefix))
    return { name: name.slice(prefix.length), args: input };
  return piToolCall(name, input);
}

function bridgedKey(name: string, args: unknown): string {
  return `${name}\n${stableJson(args ?? {})}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
