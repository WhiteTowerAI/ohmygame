import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentModelRef } from "../shared/contracts.js";
import { isOpenRouterModel, withOpenRouterAttribution } from "./openrouter-attribution.js";

export async function completeText(
  runtime: ModelRuntime,
  modelRef: AgentModelRef,
  prompt: string,
  systemPrompt: string,
  options: { maxPromptBytes: number; maxTokens: number; timeoutMs: number; separator?: string },
): Promise<string | undefined> {
  const model = runtime.getModel(modelRef.provider, modelRef.id);
  if (!model) return undefined;
  const response = await runtime.completeSimple(model, {
    systemPrompt,
    messages: [{ role: "user", content: boundedText(prompt, options.maxPromptBytes), timestamp: Date.now() }],
  }, {
    maxTokens: options.maxTokens,
    maxRetries: 0,
    signal: AbortSignal.timeout(options.timeoutMs),
    ...(isOpenRouterModel(model) ? { transformHeaders: (headers) => withOpenRouterAttribution(stringHeaders(headers)) } : {}),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
  return response.content.filter((content) => content.type === "text").map((content) => content.text).join(options.separator ?? "").trim() || undefined;
}

export function generateCreativeText(runtime: ModelRuntime, model: AgentModelRef, instruction: string): Promise<string | undefined> {
  return completeText(
    runtime,
    model,
    instruction,
    "Generate useful, polished text for a creative production workflow. Follow the user's instruction. Return only the requested text, without commentary, markdown fences, or preamble.",
    { maxPromptBytes: 12_000, maxTokens: 2_000, timeoutMs: 60_000 },
  );
}

function boundedText(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value.trim()) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function stringHeaders(headers: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
