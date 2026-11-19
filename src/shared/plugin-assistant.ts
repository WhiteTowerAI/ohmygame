// A panel's assistant (`host.assistant`, API 2.35.0): the person's model,
// run by the app in a loop with the plugin's own tools, its conversation
// kept for each panel of each project apart from the project's chats. The
// page draws it; `src/daemon/plugin-assistant.ts` runs it.

import { readPluginModelRequest, type PluginModelImage } from "./plugin-models.js";

export interface PluginAssistantRequest {
  /** What the person said. */
  text: string;
  /** Images with it, for a model that reads them; they aren't kept in the conversation. */
  images?: PluginModelImage[];
  /** What the assistant is told about its job, before the conversation. */
  system?: string;
  /** One of `models.list`; the default model when left out. */
  model?: { provider: string; id: string };
  /** The most the model writes in each step; 2,048 when left out. */
  maxTokens?: number;
}

/** One of the plugin's tools the assistant used, and what it answered. */
export interface PluginAssistantToolUse {
  id: string;
  name: string;
  input: unknown;
  result: string;
  error?: true;
}

/** The conversation as the page draws it: the person's messages, and each of the assistant's steps. */
export type PluginAssistantEntry =
  | { role: "user"; text: string; /** How many images came with it, which aren't kept. */ images?: number; at: string }
  | { role: "assistant"; text: string; tools?: PluginAssistantToolUse[]; at: string };

/** How a run is going, as the page hears it. */
export type PluginAssistantEvent =
  /** The assistant's text in a step, before the tools it uses. */
  | { type: "text"; text: string }
  /** It uses one of the plugin's tools. */
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool.result"; id: string; name: string; result: string; error?: true };

export interface PluginAssistantResult {
  /** The assistant's last text. */
  text: string;
  model: { provider: string; id: string };
  /** Tokens read and written across its steps. */
  usage: { input: number; output: number };
  steps: number;
  /** Why it stopped before it was done: `steps` after the most steps a run takes, `length` at `maxTokens`. */
  stopped?: "steps" | "length";
}

export const PLUGIN_ASSISTANT_LIMITS = {
  /** Requests to the model in one run; each counts toward the plugin's model limits. */
  steps: 8,
  /** What a conversation keeps: the newest entries, and their text together. */
  entries: 80,
  chars: 300_000,
  /** A tool's answer, as the model reads it and the conversation keeps it. */
  resultChars: 20_000,
} as const;

/** Checks a run's request from a plugin, returning it or why it is refused. */
export function readPluginAssistantRequest(value: unknown): { ok: true; request: PluginAssistantRequest } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "An assistant request is an object" };
  const { text, images, system, model, maxTokens, ...rest } = value as Record<string, unknown>;
  const other = Object.keys(rest)[0];
  if (other) return { ok: false, error: `An assistant request has no ${other}` };
  if (typeof text !== "string") return { ok: false, error: "text is what the person said" };
  // The same checks as one request to a model, which a step is.
  const read = readPluginModelRequest({ system, model, maxTokens, messages: [{ role: "user", text, ...(images !== undefined ? { images } : {}) }] });
  if (!read.ok) return read;
  const message = read.request.messages[0]!;
  return {
    ok: true,
    request: {
      text: message.text,
      ...(message.images?.length ? { images: message.images } : {}),
      ...(read.request.system ? { system: read.request.system } : {}),
      ...(read.request.model ? { model: read.request.model } : {}),
      ...(read.request.maxTokens ? { maxTokens: read.request.maxTokens } : {}),
    },
  };
}
