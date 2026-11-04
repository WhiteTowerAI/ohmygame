import path from "node:path";
import type { ApprovalDecision, ApprovalRequestDetails } from "../../shared/agent-runtimes.js";
import {
  record,
  type DriverContext,
} from "./driver-context.js";
import { JsonRpcProcess, rpcErrorCode, type JsonRpcHandlers } from "./json-rpc-process.js";
import {
  NativeSessionExpiredError,
  type NativeDriver,
  type NativeToolResult,
  type NativeTurnInput,
  type NativeTurnOutcome,
  type NativeTurnSink,
} from "./native-session.js";
import { AgentRuntimeCompatibilityError } from "./compatibility.js";
import { stageSkills } from "./skills.js";
import { BRIDGE_SERVER_NAME } from "./tool-bridge.js";

// The Agent Client Protocol, version 1: https://agentclientprotocol.com
// OhMyGame is the client. It offers no file system or terminal of its own, so
// an agent uses its own tools, and asks before using them as its rules say.

const PROTOCOL_VERSION = 1;
/** The error an agent returns when it needs signing in first. */
const AUTH_REQUIRED = -32000;
const ACP_CLIENT = { name: "ohmygame", title: "OhMyGame", version: "1" };
/** The one model of an agent that offers no choice of model. */
export const ACP_DEFAULT_MODEL = "default";

/** How a plugin agent starts. */
export interface AcpAgent {
  name: string;
  args: readonly string[];
  loginCommand?: string;
}

export class AcpSignedOutError extends Error {}

/** A connection to an agent that speaks ACP on its stdio. */
export class AcpConnection extends JsonRpcProcess {
  constructor(
    binaryPath: string,
    agent: AcpAgent,
    cwd: string,
    env: Record<string, string>,
    handlers: JsonRpcHandlers = {},
  ) {
    super(binaryPath, agent.args, cwd, env, agent.name, handlers);
  }

  /** Agrees on the protocol; returns the agent's capabilities. */
  async initialize(timeoutMs?: number): Promise<Record<string, unknown>> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: ACP_CLIENT,
      },
      timeoutMs,
    );
    if (result.protocolVersion !== PROTOCOL_VERSION)
      throw new AgentRuntimeCompatibilityError(
        `${this.name} speaks Agent Client Protocol version ${String(result.protocolVersion)}; OhMyGame speaks version ${PROTOCOL_VERSION}.`,
        "Agent Client Protocol version 1",
      );
    return record(result.agentCapabilities) ?? {};
  }
}

/** A session-level choice: a config option, or the older modes and models fields. */
interface Choice {
  /** The config option's id; absent for a mode or model set with its own method. */
  configId?: string;
  current?: string;
  values: Array<{ value: string; name: string }>;
}

/** What a session lets OhMyGame choose. */
export interface AcpChoices {
  model?: Choice;
  thought?: Choice;
  mode?: Choice;
}

/** Reads the model, reasoning and mode choices from a session's answer or update. */
export function acpChoices(session: Record<string, unknown>): AcpChoices {
  const choices: AcpChoices = {};
  const options = Array.isArray(session.configOptions)
    ? session.configOptions
    : [];
  for (const raw of options) {
    const option = record(raw);
    if (!option || option.type !== "select" || typeof option.id !== "string")
      continue;
    const values = selectValues(option.options);
    const choice: Choice = {
      configId: option.id,
      values,
      ...(typeof option.currentValue === "string"
        ? { current: option.currentValue }
        : {}),
    };
    if (option.category === "model") choices.model ??= choice;
    else if (option.category === "thought_level") choices.thought ??= choice;
    else if (option.category === "mode") choices.mode ??= choice;
  }
  const models = record(session.models);
  if (!choices.model && Array.isArray(models?.availableModels))
    choices.model = {
      values: models.availableModels.flatMap((raw) => {
        const model = record(raw);
        return typeof model?.modelId === "string"
          ? [
              {
                value: model.modelId,
                name: typeof model.name === "string" ? model.name : model.modelId,
              },
            ]
          : [];
      }),
      ...(typeof models.currentModelId === "string"
        ? { current: models.currentModelId }
        : {}),
    };
  const modes = record(session.modes);
  if (!choices.mode && Array.isArray(modes?.availableModes))
    choices.mode = {
      values: modes.availableModes.flatMap((raw) => {
        const mode = record(raw);
        return typeof mode?.id === "string"
          ? [
              {
                value: mode.id,
                name: typeof mode.name === "string" ? mode.name : mode.id,
              },
            ]
          : [];
      }),
      ...(typeof modes.currentModeId === "string"
        ? { current: modes.currentModeId }
        : {}),
    };
  return choices;
}

function selectValues(raw: unknown): Choice["values"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const item = record(entry);
    if (!item) return [];
    // Grouped options list their own options.
    if (Array.isArray(item.options)) return selectValues(item.options);
    return typeof item.value === "string"
      ? [
          {
            value: item.value,
            name: typeof item.name === "string" ? item.name : item.value,
          },
        ]
      : [];
  });
}

/** A mode that only reads, for planning turns. */
function planningMode(mode: Choice | undefined): string | undefined {
  return mode?.values.find((value) =>
    /^(?:plan|read-?only)$/i.test(value.value) ||
    /^(?:plan|read-?only)$/i.test(value.name),
  )?.value;
}

/** The mode working turns use: the session's own, or, for a session loaded while planning, the first other mode. */
function workingMode(mode: Choice | undefined): string | undefined {
  const plan = planningMode(mode);
  if (mode?.current && mode.current !== plan) return mode.current;
  return mode?.values.find((value) => value.value !== plan)?.value;
}

/** The models an agent offers, from a session started only to read them. */
export async function probeAcpModels(
  binaryPath: string,
  agent: AcpAgent,
  env: Record<string, string>,
  directory: string,
  timeoutMs: number,
): Promise<{
  models: Array<{ id: string; name: string; levels: string[] }>;
  signedOut?: true;
}> {
  const connection = new AcpConnection(binaryPath, agent, directory, env);
  try {
    await connection.initialize(timeoutMs);
    let session: Record<string, unknown>;
    try {
      session = await connection.request(
        "session/new",
        { cwd: directory, mcpServers: [] },
        timeoutMs,
      );
    } catch (cause) {
      if (rpcErrorCode(cause) === AUTH_REQUIRED)
        return { models: [], signedOut: true };
      throw cause;
    }
    const choices = acpChoices(session);
    const levels = choices.thought?.values.map((value) => value.value) ?? [];
    const models = choices.model?.values.length
      ? choices.model.values.map((value) => ({
          id: value.value,
          name: value.name,
          levels,
        }))
      : [{ id: ACP_DEFAULT_MODEL, name: agent.name, levels }];
    return { models };
  } finally {
    await connection.stop();
  }
}

interface AcpCall {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations: Array<{ path: string }>;
  content: unknown[];
  announced: boolean;
  /** One of OhMyGame's own tools, which the bridge reports instead. */
  bridged: boolean;
  finished: boolean;
}

interface AcpTurn {
  sink: NativeTurnSink;
  signal: AbortSignal;
  readOnly: boolean;
  calls: Map<string, AcpCall>;
  /** Text and reasoning blocks restart after each tool call. */
  segment: number;
  open: Set<string>;
}

interface AcpState {
  connection: AcpConnection;
  sessionId: string;
  capabilities: Record<string, unknown>;
  choices: AcpChoices;
  /** The mode a working turn uses, which a planning turn leaves for a while. */
  workingMode?: string;
  lifetime: AbortController;
  /** A new session gets OhMyGame's instructions with its first prompt. */
  instruct: boolean;
}

// Tools whose kind says little are matched to OhMyGame's own before they are shown.
const UNCLEAR_KINDS = new Set([undefined, "other", "think"]);

/**
 * Runs a conversation with an agent a plugin adds, over the Agent Client
 * Protocol. One process and one ACP session serve the conversation; a later
 * process loads the session again when the agent can.
 */
export class AcpDriver implements NativeDriver {
  #state?: AcpState;
  #starting?: Promise<AcpState>;
  #turn?: AcpTurn;
  #loading = false;
  #sessionId?: string;
  #skills?: Promise<string[]>;

  constructor(
    private readonly context: DriverContext,
    private readonly agent: AcpAgent,
  ) {
    this.#sessionId = context.resume;
  }

  async runTurn(
    input: NativeTurnInput,
    sink: NativeTurnSink,
    signal: AbortSignal,
  ): Promise<NativeTurnOutcome> {
    const turn: AcpTurn = {
      sink,
      signal,
      readOnly: input.readOnly,
      calls: new Map(),
      segment: 0,
      open: new Set(),
    };
    this.#turn = turn;
    try {
      const state = await this.#ready();
      signal.throwIfAborted();
      await this.#setMode(state, input.readOnly);
      const prompt = await this.#prompt(state, input);
      signal.throwIfAborted();
      state.instruct = false;
      const response = await state.connection.request(
        "session/prompt",
        { sessionId: state.sessionId, prompt },
        Infinity,
      );
      this.#closeText(turn);
      const usage = record(response.usage);
      if (usage)
        sink.spent({
          input: count(usage.inputTokens),
          output: count(usage.outputTokens),
          cacheRead: count(usage.cachedReadTokens),
          cacheWrite: count(usage.cachedWriteTokens),
        });
      switch (response.stopReason) {
        case "cancelled":
          return { status: "aborted", resumable: true };
        case "refusal":
          return {
            status: "failed",
            error: `${this.agent.name} refused to continue this request`,
          };
        default:
          // end_turn, or a limit of the agent's own: what it wrote stands.
          return signal.aborted
            ? { status: "aborted", resumable: true }
            : { status: "completed" };
      }
    } catch (cause) {
      this.#closeText(turn);
      if (cause instanceof NativeSessionExpiredError) throw cause;
      if (signal.aborted) return { status: "aborted" };
      return {
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    } finally {
      if (this.#turn === turn) this.#turn = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const state = this.#state;
    if (!state || !this.#turn) return;
    try {
      state.connection.notify("session/cancel", { sessionId: state.sessionId });
    } catch {
      // A stopped agent has nothing left to cancel.
    }
  }

  async dispose(): Promise<void> {
    const state = this.#state ?? (await this.#starting?.catch(() => undefined));
    this.#state = undefined;
    this.#starting = undefined;
    if (!state) return;
    state.lifetime.abort();
    await state.connection.stop();
  }

  #ready(): Promise<AcpState> {
    if (this.#state?.connection.process.running) return Promise.resolve(this.#state);
    return (this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    }));
  }

  async #start(): Promise<AcpState> {
    const { context, agent } = this;
    const lifetime = new AbortController();
    const connection = new AcpConnection(
      context.binaryPath,
      agent,
      context.workspacePath,
      context.env,
      {
        ...(context.processDirectory
          ? { processDirectory: context.processDirectory }
          : {}),
        notification: (method, params) => this.#notification(method, params),
        request: (method, params) => this.#request(method, params),
        exit: () => {
          lifetime.abort();
          if (this.#state?.connection === connection) this.#state = undefined;
        },
      },
    );
    try {
      const capabilities = await connection.initialize();
      const mcp = record(capabilities.mcpCapabilities);
      const mcpServers: unknown[] = [];
      if (mcp?.http === true && context.httpBridge) {
        // The agent connects once per session, so the token lasts as long as
        // this process; it still answers only while a turn of this conversation runs.
        const bridge = await context.httpBridge({
          signal: lifetime.signal,
          listAll: true,
          active: () => !!this.#turn && !this.#turn.signal.aborted,
          // A tool stops with the turn that called it, not with the process.
          callSignal: () => this.#turn?.signal,
          observe: (call, outcome) => this.#bridged(call, outcome),
        });
        mcpServers.push({
          type: "http",
          name: BRIDGE_SERVER_NAME,
          url: bridge.url,
          headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }],
        });
      }
      const resume = this.#sessionId;
      let session: Record<string, unknown>;
      let sessionId: string;
      if (resume) {
        const sessions = record(capabilities.sessionCapabilities);
        const method =
          capabilities.loadSession === true
            ? "session/load"
            : record(sessions?.resume)
              ? "session/resume"
              : undefined;
        if (!method)
          throw new NativeSessionExpiredError(
            `${agent.name} cannot continue an earlier session`,
          );
        // Loading replays the session's history, which the conversation already shows.
        this.#loading = true;
        try {
          session = await connection.request(method, {
            sessionId: resume,
            cwd: context.workspacePath,
            mcpServers,
          });
        } catch (cause) {
          if (rpcErrorCode(cause) === AUTH_REQUIRED) throw this.#signedOut();
          throw new NativeSessionExpiredError(
            cause instanceof Error ? cause.message : String(cause),
          );
        } finally {
          this.#loading = false;
        }
        sessionId = resume;
      } else {
        try {
          session = await connection.request("session/new", {
            cwd: context.workspacePath,
            mcpServers,
          });
        } catch (cause) {
          if (rpcErrorCode(cause) === AUTH_REQUIRED) throw this.#signedOut();
          throw cause;
        }
        if (typeof session.sessionId !== "string")
          throw new Error(`${agent.name} did not start a session`);
        sessionId = session.sessionId;
      }
      const choices = acpChoices(session ?? {});
      const state: AcpState = {
        connection,
        sessionId,
        capabilities,
        choices,
        lifetime,
        instruct: !resume,
        ...(workingMode(choices.mode)
          ? { workingMode: workingMode(choices.mode) }
          : {}),
      };
      await this.#choose(state, "model", context.model, "session/set_model", "modelId");
      if (context.reasoningLevel)
        await this.#choose(state, "thought", context.reasoningLevel);
      this.#sessionId = sessionId;
      this.#turn?.sink.nativeSession(sessionId);
      this.#state = state;
      return state;
    } catch (cause) {
      lifetime.abort();
      await connection.stop();
      throw cause;
    }
  }

  #signedOut(): Error {
    return new AcpSignedOutError(
      `${this.agent.name} is not signed in.${this.agent.loginCommand ? ` Run \`${this.agent.loginCommand}\` in a terminal, then check again in Settings → Agents.` : " Sign in with it in a terminal, then check again in Settings → Agents."}`,
    );
  }

  /** Sets a session choice the agent offers; one it does not offer is left as the agent has it. */
  async #choose(
    state: AcpState,
    key: keyof AcpChoices,
    value: string,
    method?: string,
    field?: string,
  ): Promise<void> {
    const choice = state.choices[key];
    if (!choice || choice.current === value) return;
    if (!choice.values.some((item) => item.value === value)) return;
    if (choice.configId) {
      const answer = await state.connection.request(
        "session/set_config_option",
        { sessionId: state.sessionId, configId: choice.configId, value },
      );
      if (Array.isArray(answer.configOptions))
        state.choices = { ...state.choices, ...acpChoices(answer) };
    } else if (method && field)
      await state.connection.request(method, {
        sessionId: state.sessionId,
        [field]: value,
      });
    else return;
    const updated = state.choices[key];
    if (updated) updated.current = value;
  }

  /** Planning turns use the agent's planning mode when it has one; other turns return to the working mode. */
  async #setMode(state: AcpState, readOnly: boolean): Promise<void> {
    const plan = planningMode(state.choices.mode);
    const target = readOnly ? plan : state.workingMode;
    if (!target) return;
    await this.#choose(state, "mode", target, "session/set_mode", "modeId").catch(
      () => {},
    );
  }

  async #prompt(
    state: AcpState,
    input: NativeTurnInput,
  ): Promise<unknown[]> {
    const prompt: unknown[] = [];
    const root = path.join(this.context.privateDirectory, "skills");
    const skills = await (this.#skills ??= this.context.skillDirectories.length
      ? stageSkills(this.context.skillDirectories, root).catch(() => [])
      : Promise.resolve([]));
    if (state.instruct) {
      const listed = skills.length
        ? `\n\nSkills you can read when a request calls for one:\n${skills
            .map((name) => `- ${name}: ${path.join(root, name, "SKILL.md")}`)
            .join("\n")}`
        : "";
      prompt.push({
        type: "text",
        text: `<ohmygame-instructions>\n${this.context.instructions}${listed}\n</ohmygame-instructions>`,
      });
    }
    const named = (input.skills ?? []).filter((name) => skills.includes(name));
    if (named.length)
      prompt.push({
        type: "text",
        text: `Read and follow these Skills for this request:\n${named
          .map((name) => `- ${path.join(root, name, "SKILL.md")}`)
          .join("\n")}`,
      });
    prompt.push({ type: "text", text: input.text });
    const images = record(state.capabilities.promptCapabilities)?.image === true;
    if (images)
      for (const image of input.images)
        prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
    else if (input.images.length)
      prompt.push({
        type: "text",
        text: `(${input.images.length} attached image${input.images.length === 1 ? " was" : "s were"} left out: ${this.agent.name} does not accept images.)`,
      });
    return prompt;
  }

  #notification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update" || this.#loading) return;
    const state = this.#state;
    const turn = this.#turn;
    if (params.sessionId !== (state?.sessionId ?? this.#sessionId)) return;
    const update = record(params.update);
    if (!update) return;
    if (update.sessionUpdate === "config_option_update" && state) {
      state.choices = { ...state.choices, ...acpChoices(update) };
      return;
    }
    if (update.sessionUpdate === "current_mode_update" && state?.choices.mode) {
      if (typeof update.currentModeId === "string")
        state.choices.mode.current = update.currentModeId;
      return;
    }
    if (!turn || turn.signal.aborted) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = record(update.content);
        if (content?.type !== "text" || typeof content.text !== "string") return;
        const thinking = update.sessionUpdate === "agent_thought_chunk";
        const key = `${thinking ? "thought" : "text"}-${turn.segment}`;
        turn.open.add(key);
        if (thinking) turn.sink.thinking(key, content.text);
        else turn.sink.text(key, content.text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.#toolCall(turn, update);
        return;
      case "usage_update": {
        const used = count(update.used);
        const size = count(update.size);
        turn.sink.usage(
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          size || undefined,
          used,
        );
        return;
      }
    }
  }

  #closeText(turn: AcpTurn): void {
    for (const key of turn.open)
      if (key.startsWith("thought-")) turn.sink.thinkingDone(key);
      else turn.sink.textDone(key);
    turn.open.clear();
  }

  /** Records what an update says about a tool call; `show` announces it when it is clear what it is. */
  #merge(turn: AcpTurn, update: Record<string, unknown>): AcpCall | undefined {
    const id = update.toolCallId;
    if (typeof id !== "string") return undefined;
    let call = turn.calls.get(id);
    if (!call) {
      call = {
        id,
        title: "",
        locations: [],
        content: [],
        announced: false,
        bridged: false,
        finished: false,
      };
      turn.calls.set(id, call);
    }
    if (typeof update.title === "string") call.title = update.title;
    if (typeof update.kind === "string") call.kind = update.kind;
    if (typeof update.status === "string") call.status = update.status;
    if (update.rawInput !== undefined) call.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
    if (Array.isArray(update.locations))
      call.locations = update.locations.flatMap((raw) => {
        const location = record(raw);
        return typeof location?.path === "string" ? [{ path: location.path }] : [];
      });
    if (Array.isArray(update.content)) call.content = update.content;
    if (!call.bridged && bridgedToolName(call.title, this.context.bridge.names))
      call.bridged = true;
    return call;
  }

  #announce(turn: AcpTurn, call: AcpCall): void {
    if (call.announced || call.bridged) return;
    call.announced = true;
    this.#closeText(turn);
    turn.segment++;
    const shown = shownTool(call);
    turn.sink.toolCall(call.id, shown.name, shown.args);
  }

  #toolCall(turn: AcpTurn, update: Record<string, unknown>): void {
    const call = this.#merge(turn, update);
    if (!call || call.bridged || call.finished) return;
    const done = call.status === "completed" || call.status === "failed";
    if (!UNCLEAR_KINDS.has(call.kind) || done || call.content.length)
      this.#announce(turn, call);
    if (!call.announced) return;
    if (call.status === "in_progress") turn.sink.toolStarted(call.id);
    if (done) {
      call.finished = true;
      turn.sink.toolStarted(call.id);
      turn.sink.toolResult(call.id, toolResult(call), call.status === "failed");
    } else if (call.content.length)
      turn.sink.toolUpdate(call.id, toolResult(call));
  }

  /** One of OhMyGame's tools ran: its card shows what the tool returned. */
  #bridged(
    call: { name: string; args: unknown; callId: string },
    outcome: { result: NativeToolResult; isError: boolean },
  ): void {
    const turn = this.#turn;
    if (!turn || turn.signal.aborted) return;
    const args = record(call.args) ?? {};
    // An agent may report the same call in its own words; this card replaces that one.
    for (const pending of turn.calls.values())
      if (!pending.announced && !pending.bridged && sameInput(pending, args)) {
        pending.bridged = true;
        break;
      }
    const id = `${BRIDGE_SERVER_NAME}:${call.callId}`;
    this.#closeText(turn);
    turn.segment++;
    turn.sink.toolCall(id, call.name, args);
    turn.sink.toolStarted(id);
    turn.sink.toolResult(id, outcome.result, outcome.isError);
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (method !== "session/request_permission")
      throw Object.assign(new Error(`Method not found: ${method}`), {
        rpcCode: -32601,
      });
    const cancelled = { outcome: { outcome: "cancelled" } };
    const turn = this.#turn;
    if (
      !turn ||
      turn.signal.aborted ||
      params.sessionId !== this.#state?.sessionId
    )
      return cancelled;
    const options = (Array.isArray(params.options) ? params.options : []).flatMap(
      (raw) => {
        const option = record(raw);
        return typeof option?.optionId === "string"
          ? [
              {
                optionId: option.optionId,
                name: typeof option.name === "string" ? option.name : "",
                kind: typeof option.kind === "string" ? option.kind : "",
              },
            ]
          : [];
      },
    );
    const pick = (...kinds: string[]) =>
      kinds
        .map((kind) => options.find((option) => option.kind === kind))
        .find(Boolean);
    const select = (option: { optionId: string } | undefined) =>
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : cancelled;
    const allow = pick("allow_once", "allow_always");
    const reject = pick("reject_once", "reject_always");
    const call = this.#merge(turn, record(params.toolCall) ?? {});
    // OhMyGame's own tools need no permission; the daemon runs them.
    if (call?.bridged) return select(allow);
    // Planning never stops to ask: what the agent would ask about is not reading.
    if (turn.readOnly) return select(reject);
    if (this.context.permissionMode === "allow") return select(allow);
    if (call) this.#announce(turn, call);
    const always = pick("allow_always");
    let decision: ApprovalDecision;
    try {
      decision = await turn.sink.requestApproval(approvalDetails(call, always), {
        ...(call?.announced ? { callId: call.id } : {}),
        signal: turn.signal,
      });
    } catch {
      decision = "deny";
    }
    if (turn.signal.aborted || this.#turn !== turn) return cancelled;
    if (decision === "deny") return select(reject);
    return select(decision === "allow-always" ? (always ?? allow) : allow);
  }
}

/** OhMyGame's tool an agent names in a tool call's title, as agents prefix MCP tools. */
export function bridgedToolName(
  title: string,
  names: readonly string[],
): string | undefined {
  const text = title.trim();
  const server = BRIDGE_SERVER_NAME;
  return names.find((name) =>
    [`mcp__${server}__${name}`, `${server}__${name}`, `${server}_${name}`, `${server}.${name}`, `${server}/${name}`, `${server}:${name}`].some(
      (prefixed) =>
        text === prefixed ||
        text.startsWith(`${prefixed} `) ||
        text.startsWith(`${prefixed}(`),
    ) || text.startsWith(`${name} (${server}`),
  );
}

function sameInput(call: AcpCall, args: Record<string, unknown>): boolean {
  const expected = canonical(args);
  if (call.rawInput !== undefined && canonical(call.rawInput) === expected)
    return true;
  try {
    return canonical(JSON.parse(call.title)) === expected;
  } catch {
    return false;
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}

/** A tool card in Pi's names where the kind says which, so it looks the same whoever ran it. */
function shownTool(call: AcpCall): {
  name: string;
  args: Record<string, unknown>;
} {
  const input = record(call.rawInput) ?? {};
  const file = call.locations[0]?.path;
  const title = call.title || call.kind || "tool";
  switch (call.kind) {
    case "execute": {
      const command = Array.isArray(input.command)
        ? input.command.map(String).join(" ")
        : typeof input.command === "string"
          ? input.command
          : title;
      return { name: "bash", args: { command, description: title } };
    }
    case "read":
      return file ? { name: "read", args: { path: file } } : { name: title, args: input };
    case "edit":
    case "delete":
    case "move":
      return file ? { name: "edit", args: { path: file } } : { name: title, args: input };
    default:
      return { name: title, args: input };
  }
}

function toolResult(call: AcpCall): NativeToolResult {
  const content: NativeToolResult["content"] = [];
  for (const raw of call.content) {
    const item = record(raw);
    if (item?.type === "content") {
      const block = record(item.content);
      if (block?.type === "text" && typeof block.text === "string")
        content.push({ type: "text", text: block.text });
      else if (
        block?.type === "image" &&
        typeof block.data === "string" &&
        typeof block.mimeType === "string"
      )
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else if (item?.type === "diff" && typeof item.path === "string")
      content.push({
        type: "text",
        text: `${item.path}\n${typeof item.newText === "string" ? item.newText : ""}`,
      });
  }
  if (!content.length && call.rawOutput !== undefined)
    content.push({
      type: "text",
      text:
        typeof call.rawOutput === "string"
          ? call.rawOutput
          : JSON.stringify(call.rawOutput),
    });
  return { content };
}

function approvalDetails(
  call: AcpCall | undefined,
  always: { name: string } | undefined,
): ApprovalRequestDetails {
  const input = record(call?.rawInput) ?? {};
  const file = call?.locations[0]?.path;
  const command = Array.isArray(input.command)
    ? input.command.map(String).join(" ")
    : typeof input.command === "string"
      ? input.command
      : undefined;
  return {
    kind:
      call?.kind === "execute"
        ? "command"
        : call?.kind && ["read", "edit", "delete", "move"].includes(call.kind)
          ? "file"
          : "tool",
    tool: call?.title || call?.kind || "tool",
    ...(call?.title ? { title: call.title } : {}),
    ...(command ? { command } : {}),
    ...(file ? { path: file } : {}),
    // The agent's own "always" option, saved in its own settings.
    ...(always ? { always: { scope: "saved" as const, rules: [always.name] } } : {}),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}
