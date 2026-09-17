import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef } from "../shared/contracts.js";
import { completeText } from "./text-generation.js";

const TITLE_MAX_LENGTH = 36;
const TITLE_PROMPT_MAX_BYTES = 960;

export type TitleGenerator = (
  model: AgentModelRef,
  prompt: string,
) => Promise<string | undefined>;

export function generateConversationTitle(
  runtime: ModelRuntime,
  modelRef: AgentModelRef,
  prompt: string,
): Promise<string | undefined> {
  return generateTitle(runtime, modelRef, prompt, [
    `Generate a concise, single-line task title of at most ${TITLE_MAX_LENGTH} characters and under five words where possible.`,
    "Start with an imperative verb. Preserve the user's language, proper nouns, code terms, and issue references.",
    "Do not use quotes, markdown, emojis, or trailing punctuation. Return only the title and do not answer the request.",
  ].join(" "));
}

export function generateProjectTitle(
  runtime: ModelRuntime,
  modelRef: AgentModelRef,
  prompt: string,
): Promise<string | undefined> {
  return generateTitle(runtime, modelRef, prompt, [
    `Generate a concise, single-line project name of at most ${TITLE_MAX_LENGTH} characters and under five words where possible.`,
    "Name the game or product being created. Prefer a noun phrase, not an instruction or task description.",
    "Preserve the user's language, proper nouns, and important creative terms.",
    "Do not use quotes, markdown, emojis, or trailing punctuation. Return only the name and do not answer the request.",
  ].join(" "));
}

async function generateTitle(
  runtime: ModelRuntime,
  modelRef: AgentModelRef,
  prompt: string,
  systemPrompt: string,
): Promise<string | undefined> {
  const text = await completeText(runtime, modelRef, prompt.replace(/\s+/g, " ").trim(), systemPrompt, {
    maxPromptBytes: TITLE_PROMPT_MAX_BYTES,
    maxTokens: 80,
    timeoutMs: 30_000,
    separator: " ",
  });
  if (!text) return undefined;
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
