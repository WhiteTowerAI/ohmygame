import type { CheckpointChangeItem, ConversationSummary, ProjectState, ThreadItem } from "../shared/contracts.js";
import type { UsageRow } from "../shared/usage-stats.js";
import { conversationItems } from "./agent.js";
import type { ConversationManager } from "./conversations.js";

// What a plugin page may read about its project, each behind its own
// capability: the turns that changed files (`project.history`) and what the
// project's conversations used (`project.usage`). Both are read-only.

/** The longest message a history entry carries. */
export const HISTORY_MESSAGE_MAX_CHARS = 2_000;
/** Conversations read for one history request, newest first. */
const HISTORY_CONVERSATIONS_MAX = 50;

export interface PluginHistoryTurn {
  conversation: { id: string; title: string };
  /** When the message was sent, as an ISO date. */
  at?: string;
  /** What the person asked, cut to `HISTORY_MESSAGE_MAX_CHARS`. */
  message: string;
  changes: Array<Pick<CheckpointChangeItem, "path" | "kind" | "lines">>;
  /** The turn's changes were taken back with Undo. */
  undone?: boolean;
}

type UserMessage = Extract<ThreadItem, { type: "userMessage" }> & { timestamp?: number };

/** The project's latest turns that changed files, newest first. */
export async function projectHistory(
  project: ProjectState,
  conversations: Pick<ConversationManager, "list" | "get" | "view">,
  limit: number,
): Promise<PluginHistoryTurn[]> {
  const turns: Array<PluginHistoryTurn & { time: number }> = [];
  const summaries: ConversationSummary[] = (await conversations.list(project)).slice(0, HISTORY_CONVERSATIONS_MAX);
  for (const summary of summaries) {
    // A conversation's turns are no newer than its last update: once enough
    // newer turns are in, the rest can't make the list.
    if (turns.length >= limit && Date.parse(summary.updatedAt) < turns[limit - 1]!.time) break;
    const stored = await conversations.get(project, summary.id).catch(() => undefined);
    if (!stored) continue;
    const branch = (await conversations.view(project, stored)).getBranch();
    for (const item of conversationItems(branch, false)) {
      if (item.type !== "userMessage" || !item.changes?.files) continue;
      const message = item as UserMessage;
      turns.push({
        conversation: { id: summary.id, title: summary.title },
        ...(message.timestamp !== undefined ? { at: new Date(message.timestamp).toISOString() } : {}),
        message: message.text.length > HISTORY_MESSAGE_MAX_CHARS ? `${message.text.slice(0, HISTORY_MESSAGE_MAX_CHARS - 1)}…` : message.text,
        changes: (message.changes?.items ?? []).map(({ path, kind, lines }) => ({ path, kind, ...(lines ? { lines } : {}) })),
        ...(message.changes?.undone ? { undone: true } : {}),
        time: message.timestamp ?? Date.parse(summary.updatedAt),
      });
    }
    turns.sort((left, right) => right.time - left.time);
  }
  return turns.slice(0, limit).map(({ time: _, ...turn }) => turn);
}

/** One day's use of one model in the project, without the project's id. */
export type PluginUsageRow = Omit<UsageRow, "projectId">;

export function projectUsage(rows: readonly UsageRow[], projectId: string): PluginUsageRow[] {
  return rows.filter((row) => row.projectId === projectId).map(({ projectId: _, ...row }) => row);
}
