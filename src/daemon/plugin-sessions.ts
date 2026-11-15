import { randomUUID } from "node:crypto";
import type {
  PluginSessionRequest,
  PluginSessionResults,
  PluginSessionMessage,
} from "../shared/plugin-sessions.js";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { AgentManager, conversationItems } from "./agent.js";
import type {
  ConversationManager,
  StoredConversation,
} from "./conversations.js";

/** Domain adapter shared by native messaging plugins. The daemon owns accepted turns. */
export class PluginSessions {
  readonly #epoch = randomUUID();
  constructor(
    private readonly options: {
      projects: {
        list(): ProjectState[];
        get(id: string): ProjectState | undefined;
      };
      conversations: ConversationManager;
      agents: AgentManager;
      events: RuntimeEventBus;
      settings?(
        project: ProjectState,
        conversation: StoredConversation,
      ): Promise<PluginSessionResults["settings"]>;
      changeModel?(
        project: ProjectState,
        conversation: StoredConversation,
        model: { provider: string; id: string },
        authorize: () => Promise<void>,
      ): Promise<unknown>;
      changeReasoning?(
        project: ProjectState,
        conversation: StoredConversation,
        level: string,
        authorize: () => Promise<void>,
        model: { provider: string; id: string },
      ): Promise<unknown>;
      prepare(
        project: ProjectState,
        conversation: StoredConversation,
      ): Promise<void>;
      sent(
        project: ProjectState,
        conversation: StoredConversation,
        text: string,
      ): void;
    },
  ) {}

  async handle(
    plugin: string,
    input: PluginSessionRequest,
    signal: AbortSignal,
    authorize: () => Promise<void>,
  ): Promise<unknown> {
    const request = validateRequest(input);
    const { projects, conversations, agents } = this.options;
    signal.throwIfAborted();
    if (request.operation === "projects") {
      const all = projects.list();
      return {
        projects: all
          .slice(0, 500)
          .map(({ id, name }) => ({ id, name: name.slice(0, 500) })),
        truncated: all.length > 500,
      } satisfies PluginSessionResults["projects"];
    }
    const project = projects.get(request.projectId);
    if (!project) throw new Error("Project not found");
    if (request.operation === "events") return this.#events(request, signal);
    if (request.operation === "conversations") {
      const all = await conversations.list(project);
      return {
        conversations: all
          .slice(0, 500)
          .map(({ id, title }) => ({ id, title: title.slice(0, 500) })),
        truncated: all.length > 500,
      } satisfies PluginSessionResults["conversations"];
    }
    if (request.operation === "create") {
      await authorize();
      return { id: (await conversations.create(project)).summary.id };
    }
    if (!("conversationId" in request))
      throw new Error("Conversation is required");
    const conversation = await conversations.get(
      project,
      request.conversationId,
    );
    if (!conversation) throw new Error("Conversation not found or archived");
    const check = async () => {
      signal.throwIfAborted();
      await authorize();
      signal.throwIfAborted();
      if (projects.get(project.id) !== project)
        throw new Error("Project changed");
    };
    if (request.operation === "settings") {
      if (!this.options.settings)
        throw new Error("Session settings unavailable");
      return this.options.settings(project, conversation);
    }
    if (request.operation === "model" || request.operation === "reasoning") {
      if (
        !this.options.settings ||
        !this.options.changeModel ||
        !this.options.changeReasoning
      )
        throw new Error("Session settings unavailable");
      const settings = await this.options.settings(project, conversation);
      if (settings.busy) throw new Error("Project is busy");
      if (
        !settings.models.some(
          (m) =>
            m.provider === request.model.provider && m.id === request.model.id,
        )
      )
        throw new Error("Model is not available");
      if (request.operation === "model")
        await this.options.changeModel(
          project,
          conversation,
          request.model,
          check,
        );
      else
        await this.options.changeReasoning(
          project,
          conversation,
          request.level,
          check,
          request.model,
        );
      return { changed: true };
    }
    if (request.operation === "read") {
      // Capture before asynchronous reads: replay may repeat a change but cannot skip it.
      const cursor = this.#cursor();
      const branch = (
        await conversations.view(project, conversation)
      ).getBranch();
      const start = agents.activeStart(project.id, conversation.summary.id);
      const items = [
        ...conversationItems(
          start
            ? branch.filter((entry) => entry.timestamp < start.timestamp)
            : branch,
          !start,
        ),
        ...(start
          ? agents.activeItems(project.id, conversation.summary.id)
          : []),
      ];
      const messages: PluginSessionMessage[] = [];
      let remaining = 256_000;
      let truncated = false;
      for (const item of items.toReversed()) {
        if (item.type !== "userMessage" && item.type !== "agentMessage")
          continue;
        if (messages.length >= 200 || remaining <= 0) {
          truncated = true;
          break;
        }
        const text = item.text.slice(0, Math.min(32_000, remaining));
        remaining -= text.length;
        truncated ||=
          text.length < item.text.length ||
          (item.type === "agentMessage" &&
            (item.error?.message.length ?? 0) > 2_000);
        messages.push({
          id: item.id,
          turnId: item.turnId,
          role: item.type === "userMessage" ? "user" : "assistant",
          text,
          ...(item.type === "agentMessage"
            ? {
                status: item.status,
                ...(item.error
                  ? {
                      error: {
                        message: item.error.message.slice(0, 2_000),
                        ...(item.error.code ? { code: item.error.code } : {}),
                      },
                    }
                  : {}),
              }
            : {}),
          ...(item.type === "userMessage" && item.source
            ? { source: item.source }
            : {}),
        });
      }
      return {
        messages: messages.reverse(),
        truncated,
        status: agents.agentState(conversation).status,
        needsApproval: items.some(
          (item) =>
            item.type === "approvalRequest" && item.status === "inProgress",
        ),
        cursor,
      } satisfies PluginSessionResults["read"];
    }
    if (request.operation === "stop") {
      await authorize();
      const turnId = agents.activeTurnId(project.id, conversation.summary.id);
      if (request.turnId !== undefined && request.turnId !== turnId)
        return { stopped: false };
      if (turnId)
        await agents.cancel(project.id, conversation.summary.id, turnId);
      return { stopped: Boolean(turnId) };
    }
    if (request.operation === "send") {
      if (agents.isProjectBusy(project.id))
        throw new Error("Project is busy; plugin messages are not queued");
      agents.restorePlanState(
        conversation,
        await conversations.planState(project, conversation),
      );
      if (agents.planState(conversation).mode !== "normal")
        throw new Error("Finish or cancel the plan in OhMyGame first");
      await this.options.prepare(project, conversation);
      await authorize();
      if (projects.get(project.id) !== project)
        throw new Error("Project changed while sending");
      const turn = agents.prompt(
        project,
        conversation,
        request.text,
        [],
        [],
        "normal",
        [],
        randomUUID(),
        "",
        [],
        { plugin },
      );
      // This callback is bookkeeping, never the acknowledgement of execution.
      this.options.sent(project, conversation, request.text);
      return { turnId: turn.turnId };
    }
    throw new Error("Unknown session operation");
  }

  #cursor(): string {
    return `${this.#epoch}:${this.options.events.cursor()}`;
  }

  async #events(
    request: Extract<PluginSessionRequest, { operation: "events" }>,
    signal: AbortSignal,
  ): Promise<PluginSessionResults["events"]> {
    const bus = this.options.events;
    const [epoch, raw] = request.after?.split(":") ?? [];
    const cursor = Number(raw);
    const reset =
      request.after !== undefined &&
      (epoch !== this.#epoch ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        cursor > bus.cursor() ||
        !bus.canReplay(request.projectId, cursor));
    if (request.after === undefined || reset)
      return { cursor: this.#cursor(), reset, events: [] };
    if (!bus.since(request.projectId, cursor).length && request.waitMs) {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        };
        const abort = () =>
          finish(signal.reason ?? new Error("Session wait cancelled"));
        const unsubscribe = bus.subscribe(request.projectId, () => finish());
        const timer = setTimeout(() => finish(), request.waitMs);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    // A burst while waking can overflow the buffer too.
    if (!bus.canReplay(request.projectId, cursor))
      return { cursor: this.#cursor(), reset: true, events: [] };
    return {
      cursor: this.#cursor(),
      reset: false,
      events: bus
        .since(request.projectId, cursor)
        .map(({ type, conversationId, turnId, timestamp }) => ({
          type,
          ...(conversationId ? { conversationId } : {}),
          ...(turnId ? { turnId } : {}),
          timestamp,
        })),
    };
  }
}

function validateRequest(input: unknown): PluginSessionRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid session request");
  const value = input as Record<string, unknown>;
  const keys: Record<string, string[]> = {
    projects: [],
    conversations: ["projectId"],
    create: ["projectId"],
    read: ["projectId", "conversationId"],
    send: ["projectId", "conversationId", "text"],
    stop: ["projectId", "conversationId", "turnId"],
    settings: ["projectId", "conversationId"],
    model: ["projectId", "conversationId", "model"],
    reasoning: ["projectId", "conversationId", "model", "level"],
    events: ["projectId", "after", "waitMs"],
  };
  if (
    typeof value.operation !== "string" ||
    !Object.hasOwn(keys, value.operation)
  )
    throw new Error("Unknown session operation");
  const allowed = keys[value.operation]!;
  if (
    Object.keys(value).some(
      (key) => key !== "operation" && !allowed.includes(key),
    )
  )
    throw new Error("Unknown session request field");
  for (const key of allowed.filter(
    (key) => key === "projectId" || key === "conversationId",
  )) {
    if (
      typeof value[key] !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value[key])
    )
      throw new Error(`Invalid ${key}`);
  }
  if (value.operation === "model" || value.operation === "reasoning") {
    const model = value.model as Record<string, unknown> | undefined;
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      Object.keys(model).some((key) => key !== "provider" && key !== "id") ||
      [model.provider, model.id].some(
        (v) => typeof v !== "string" || !v.trim() || v.length > 500,
      )
    )
      throw new Error("Invalid model");
    if (
      value.operation === "reasoning" &&
      (typeof value.level !== "string" ||
        !value.level ||
        value.level.length > 100)
    )
      throw new Error("Invalid reasoning level");
  }
  if (
    value.turnId !== undefined &&
    (typeof value.turnId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.turnId))
  )
    throw new Error("Invalid turn ID");
  if (
    value.operation === "send" &&
    (typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 32_000)
  )
    throw new Error("Message must contain 1–32000 characters");
  if (
    value.after !== undefined &&
    (typeof value.after !== "string" || value.after.length > 100)
  )
    throw new Error("Invalid event cursor");
  if (
    value.waitMs !== undefined &&
    (!Number.isInteger(value.waitMs) ||
      (value.waitMs as number) < 0 ||
      (value.waitMs as number) > 25_000)
  )
    throw new Error("Wait must be 0–25000 milliseconds");
  return input as PluginSessionRequest;
}
