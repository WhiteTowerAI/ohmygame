import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef } from "../shared/contracts.js";

const TITLE_MAX_LENGTH = 36;
const TITLE_PROMPT_MAX_BYTES = 960;

export type ConversationTitleGenerator = (
  model: AgentModelRef,
  prompt: string,
) => Promise<string | undefined>;

export async function generateConversationTitle(
  runtime: ModelRuntime,
  modelRef: AgentModelRef,
  prompt: string,
): Promise<string | undefined> {
  const model = runtime.getModel(modelRef.provider, modelRef.id);
  if (!model) return undefined;
  const response = await runtime.completeSimple(model, {
    systemPrompt: titleInstructions(),
    messages: [{
      role: "user",
      content: boundedPrompt(prompt),
      timestamp: Date.now(),
    }],
  }, {
    maxTokens: 80,
    maxRetries: 0,
    signal: AbortSignal.timeout(30_000),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
  const text = response.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join(" ");
  return normalizeGeneratedTitle(text);
}

export function normalizeGeneratedTitle(value: string): string | undefined {
  const title = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？]+$/, "")
    .trim();
  if (!title) return undefined;
  return [...title].slice(0, TITLE_MAX_LENGTH).join("");
}

function titleInstructions(): string {
  return [
    `Generate a concise, single-line task title of at most ${TITLE_MAX_LENGTH} characters and under five words where possible.`,
    "Start with an imperative verb. Preserve the user's language, proper nouns, code terms, and issue references.",
    "Do not use quotes, markdown, emojis, or trailing punctuation. Return only the title and do not answer the request.",
  ].join(" ");
}

function boundedPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  let bytes = 0;
  let result = "";
  for (const character of normalized) {
    const size = Buffer.byteLength(character);
    if (bytes + size > TITLE_PROMPT_MAX_BYTES) break;
    bytes += size;
    result += character;
  }
  return result;
}
