import type { AudioKind } from "./audio.js";

// compat: since beta.5.6, remove from beta.7 and 2026-12-12. The speech, sound-effect, music and audio-scene nodes and the generate-speech, generate-sound-effect and generate-music tools, merged into the audio node and generate-audio. Read from board files, browser drafts, the clipboard, plugin presets and generation history.

const NODE_KINDS: Readonly<Record<string, AudioKind | null>> = { speech: "speech", "sound-effect": "sound-effect", music: "music", "audio-scene": null };
const TOOL_KINDS: Readonly<Record<string, AudioKind>> = { "generate-speech": "speech", "generate-sound-effect": "sound-effect", "generate-music": "music" };

/** Seed Audio used to get these ahead of the prompt; they move into it so older work sounds the same. */
const SEED_AUDIO_INSTRUCTIONS: Readonly<Record<AudioKind, string>> = {
  speech: "Speak the following text exactly. ",
  "sound-effect": "Create a standalone game sound effect. Do not include speech, narration, singing, or background music. Description: ",
  music: "Create instrumental game background music. Do not include vocals, speech, narration, or lyrics. Description: ",
};

type Data = Record<string, unknown> & { model?: { provider?: unknown }; text?: unknown; prompt?: unknown; durationSeconds?: unknown };

function audioData(kind: AudioKind | null, data: Data): Record<string, unknown> {
  // Lyrics and negative prompts were never supported by a provider; the operation is now the model's.
  const { text, lyrics: _lyrics, negativePrompt: _negative, operation: _operation, ...rest } = data;
  const own = typeof (kind === "speech" ? text : rest.prompt) === "string" ? String(kind === "speech" ? text : rest.prompt) : "";
  const prompt = kind && own && rest.model?.provider === "volcengine-seed-audio" ? `${SEED_AUDIO_INSTRUCTIONS[kind]}${own}` : own;
  // Audio scenes took any positive length; audio nodes start at 0.1 seconds.
  const duration = typeof rest.durationSeconds === "number" && rest.durationSeconds < 0.1 ? { durationSeconds: 0.1 } : {};
  return { ...rest, prompt, ...duration };
}

/** Reads each speech, sound-effect, music or audio-scene node as an audio node. */
export function migrateLegacyAudioNodes<T>(value: T): { value: T; migrated: string[] } {
  const nodes = value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  const legacy = (node: unknown): node is { id?: unknown; type: string; data?: Data } =>
    Boolean(node && typeof node === "object" && typeof (node as { type?: unknown }).type === "string" && (node as { type: string }).type in NODE_KINDS);
  if (!Array.isArray(nodes) || !nodes.some(legacy)) return { value, migrated: [] };
  const migrated: string[] = [];
  return {
    value: { ...value, nodes: nodes.map((node) => {
      if (!legacy(node)) return node;
      migrated.push(String(node.id));
      return { ...node, type: "audio", data: audioData(NODE_KINDS[node.type]!, node.data ?? {}) };
    }) },
    migrated,
  };
}

/** Reads a job or run of a per-kind audio tool as `generate-audio`, keeping the kind so a retry picks a fitting model. */
export function migrateLegacyAudioJob<T extends { toolId?: unknown; input?: unknown }>(record: T): T {
  const kind = typeof record.toolId === "string" ? TOOL_KINDS[record.toolId] : undefined;
  if (!kind) return record;
  const input = record.input && typeof record.input === "object" ? { input: { ...audioData(kind, record.input as Data), kind } } : {};
  return { ...record, toolId: "generate-audio", ...input };
}
