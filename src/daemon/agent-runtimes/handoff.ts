import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const MAX_SUMMARY = 12_000;
const MAX_MESSAGE = 1_500;
const MAX_TURNS = 12;

/**
 * What an agent is told about a conversation it joins: the recent messages
 * and the files the earlier agent touched, taken from the stored messages as
 * they are. Nothing is asked of a model, so switching agents costs nothing
 * and says the same thing every time. Older turns that do not fit are left
 * out; the workspace itself is the record of what was built.
 */
export function handoffSummary(
  entries: readonly SessionEntry[],
): string | undefined {
  const turns: string[][] = [];
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      turns.push([`Earlier conversation summary:\n${clip(entry.summary)}`]);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; content: unknown };
    if (message.role === "user") {
      const text = userText(message.content);
      if (text) turns.push([`User: ${clip(text)}`]);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      const current = turns.at(-1) ?? (turns.push([]), turns.at(-1)!);
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim()
        )
          current.push(`Assistant: ${clip(block.text.trim())}`);
        if (block.type === "toolCall") {
          const file = filePath(block.arguments);
          if (file) files.add(file);
        }
      }
    }
  }
  if (turns.length === 0) return undefined;
  const kept: string[] = [];
  let length = 0;
  for (const turn of turns.slice(-MAX_TURNS).reverse()) {
    const text = turn.join("\n");
    if (length + text.length > MAX_SUMMARY && kept.length) break;
    kept.unshift(text);
    length += text.length;
  }
  const omitted = turns.length - kept.length;
  const plan = entries.findLast(
    (entry) => entry.type === "custom" && entry.customType === "ohmygame-plan",
  );
  const restored = entries.some(
    (entry) =>
      entry.type === "custom" &&
      (entry.customType === "ohmygame-checkpoint-restored" ||
        entry.customType === "ohmygame-checkpoint-undone"),
  );
  return [
    "<conversation-handoff>",
    "This conversation began with another agent in OhMyGame. You are continuing it. Here is what was said so far; the workspace files show what was built. Do not redo finished work.",
    ...(omitted > 0
      ? [`(${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted)`]
      : []),
    ...kept,
    ...(plan?.type === "custom"
      ? [`Current structured plan state:\n${clip(JSON.stringify(plan.data))}`]
      : []),
    ...(restored
      ? [
          "The workspace has been restored or a turn was undone. Inspect the current files before continuing; earlier descriptions may no longer match them.",
        ]
      : []),
    ...(files.size
      ? [
          `Files the earlier agent worked on: ${[...files].slice(-40).join(", ")}`,
        ]
      : []),
    "</conversation-handoff>",
  ].join("\n\n");
}

function userText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              part &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text"
                ? [String((part as { text?: unknown }).text ?? "")]
                : [],
            )
            .join("\n")
        : "";
  // Private context OhMyGame attaches to a message is for the turn it was sent with.
  return text
    .replace(
      /<(workspace-file-references|local-attachments|editor-context)>[\s\S]*?<\/\1>/g,
      "",
    )
    .trim();
}

function filePath(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const values = args as Record<string, unknown>;
  const value = values.path ?? values.file_path ?? values.filePath;
  return typeof value === "string" && value ? value : undefined;
}

function clip(text: string): string {
  return text.length <= MAX_MESSAGE ? text : `${text.slice(0, MAX_MESSAGE)}…`;
}
