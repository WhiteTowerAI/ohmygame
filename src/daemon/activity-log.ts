import type {
  PreviewRuntimeState,
  RuntimeEvent,
  ThreadItem,
} from "../shared/contracts.js";
import { createLogRedactor } from "../shared/log-redaction.js";

const redact = createLogRedactor();

const MAX_DETAIL_LENGTH = 1_000;
/** The end of a failed preview's output, where the error usually is. */
const MAX_PREVIEW_OUTPUT = 2_000;
/**
 * The end of a failed tool's output. A failed shell command's output can hold
 * project text; its error is usually in the last lines.
 */
const MAX_TOOL_ERROR = 500;

export interface ActivityLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/**
 * What the agent, previews and publishing did, for the daemon log: IDs,
 * outcomes, durations and errors. It never records prompts, messages, or
 * tool input and output other than a failed tool's error.
 */
export class ActivityLog {
  readonly #turns = new Map<string, number>();
  readonly #previews = new Map<string, PreviewRuntimeState["status"]>();

  constructor(
    private readonly log: ActivityLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs inside event publishing, so a logging failure must never reach the agent or preview that published. */
  event(event: RuntimeEvent): void {
    try {
      this.#record(event);
    } catch (error) {
      try {
        this.log.warn(
          { err: error, type: event.type },
          "Could not log activity",
        );
      } catch {
        // The logger itself failed; the event still goes on.
      }
    }
  }

  #record(event: RuntimeEvent): void {
    const scope = {
      projectId: event.projectId,
      ...(event.conversationId ? { conversationId: event.conversationId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    };
    switch (event.type) {
      case "agent.started":
        this.#turns.set(turnKey(event), this.now());
        this.log.info(
          {
            ...scope,
            ...(event.data.revision ? { revision: event.data.revision } : {}),
            images: event.data.images?.length ?? 0,
            attachments: event.data.attachments?.length ?? 0,
            plugins: event.data.mentions?.map((mention) => mention.name) ?? [],
          },
          "Agent turn started",
        );
        return;
      case "agent.completed":
        this.log.info(
          { ...scope, ...this.#duration(event) },
          "Agent turn completed",
        );
        return;
      case "agent.cancelled":
        this.log.info(
          { ...scope, ...this.#duration(event) },
          "Agent turn cancelled",
        );
        return;
      case "agent.error":
        this.log.warn(
          {
            ...scope,
            ...this.#duration(event),
            error: truncate(event.data.error),
            ...(event.data.code ? { code: event.data.code } : {}),
            ...(event.data.diagnostics ? { diagnostics: event.data.diagnostics } : {}),
          },
          "Agent turn failed",
        );
        return;
      case "conversation.model.changed":
        this.log.info(
          {
            ...scope,
            model: `${event.data.item.model.provider}/${event.data.item.model.id}`,
          },
          "Conversation model changed",
        );
        return;
      case "item.started":
        if (event.data.item.type === "retry")
          this.#retry(scope, event.data.item);
        return;
      case "item.completed":
        this.#toolFailure(scope, event.data.item);
        return;
      case "preview.updated":
        this.#preview(event.projectId, event.data.preview);
        return;
      case "publish.started":
        this.log.info(scope, "Publish started");
        return;
      case "publish.completed":
        this.log.info(scope, "Publish completed");
        return;
      case "publish.error":
        this.log.warn(
          { ...scope, error: truncate(event.data.error) },
          "Publish failed",
        );
        return;
      default:
        return;
    }
  }

  #duration(event: RuntimeEvent): { durationMs?: number } {
    const key = turnKey(event);
    const started = this.#turns.get(key);
    this.#turns.delete(key);
    return started === undefined ? {} : { durationMs: this.now() - started };
  }

  #retry(scope: object, item: Extract<ThreadItem, { type: "retry" }>): void {
    this.log.warn(
      {
        ...scope,
        attempt: item.attempt,
        maxAttempts: item.maxAttempts,
        delayMs: item.delayMs,
        ...(item.error.code ? { code: item.error.code } : {}),
        error: truncate(item.error.message),
      },
      "Model request will be retried",
    );
  }

  #toolFailure(scope: object, item: ThreadItem): void {
    if (item.type !== "dynamicToolCall" && item.type !== "mcpToolCall") return;
    if (item.status !== "failed") return;
    this.log.warn(
      {
        ...scope,
        tool: item.tool,
        ...(item.type === "mcpToolCall" && item.server
          ? { server: item.server }
          : {}),
        error: redact(item.output ?? "", {
          maxLength: MAX_TOOL_ERROR,
          tail: true,
        }),
      },
      "Agent tool failed",
    );
  }

  #preview(projectId: string, preview: PreviewRuntimeState): void {
    if (this.#previews.get(projectId) === preview.status) return;
    this.#previews.set(projectId, preview.status);
    const details = {
      projectId,
      status: preview.status,
      ...(preview.manager ? { manager: preview.manager } : {}),
      ...(preview.command ? { command: preview.command } : {}),
      ...(preview.stopReason ? { stopReason: preview.stopReason } : {}),
    };
    if (preview.status !== "error") {
      this.log.info(details, `Preview ${preview.status}`);
      return;
    }
    this.log.warn(
      {
        ...details,
        ...(preview.phase ? { phase: preview.phase } : {}),
        error: truncate(preview.error ?? ""),
        ...(preview.logs
          ? {
              output: redact(preview.logs, {
                maxLength: MAX_PREVIEW_OUTPUT,
                tail: true,
              }),
            }
          : {}),
      },
      "Preview failed",
    );
  }
}

function turnKey(event: RuntimeEvent): string {
  return `${event.projectId}/${event.conversationId ?? ""}`;
}

function truncate(text: string): string {
  const redacted = redact(text, { maxLength: MAX_DETAIL_LENGTH + 1 });
  return redacted.length > MAX_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_DETAIL_LENGTH)}…`
    : redacted;
}
