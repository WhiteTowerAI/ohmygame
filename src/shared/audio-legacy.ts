import { DOUBAO_SPEECH_PROVIDER_ID, type AudioKind } from "./audio.js";
import type { ModelRef } from "./contracts.js";

// compat: since beta.5.6, remove from beta.7 and 2026-12-12. The speech, sound-effect, music and audio-scene nodes and the generate-speech, generate-sound-effect and generate-music tools, merged into the audio node and generate-audio. Read from board files, browser drafts, the clipboard, plugin presets and generation history.
// compat: since beta.5.0, remove from beta.7 and 2026-11-28. Audio references and subtitles, which no generation uses since beta.5.0, are dropped from audio nodes as they load.
const DROPPED = ["subtitles", "audioReferences", "audioReferenceSerial"] as const;
// compat: since beta.5.6, remove from beta.7 and 2026-12-12. Seed Audio had its own provider ID before it became a model of Doubao Speech.
const SEED_AUDIO_PROVIDER_ID = "volcengine-seed-audio";

/** A saved audio model choice under the provider that offers it now. */
export function currentAudioModel<T extends ModelRef | undefined>(model: T): T {
  return model?.provider === SEED_AUDIO_PROVIDER_ID ? { ...model, provider: DOUBAO_SPEECH_PROVIDER_ID } : model;
}
const oldModel = (model: unknown): model is ModelRef => Boolean(model && typeof model === "object" && (model as { provider?: unknown }).provider === SEED_AUDIO_PROVIDER_ID);

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
  const { text, lyrics: _lyrics, negativePrompt: _negative, operation: _operation, subtitles: _subtitles, audioReferences: _references, audioReferenceSerial: _serial, ...rest } = data;
  const own = typeof (kind === "speech" ? text : rest.prompt) === "string" ? String(kind === "speech" ? text : rest.prompt) : "";
  const prompt = kind && own && rest.model?.provider === SEED_AUDIO_PROVIDER_ID ? `${SEED_AUDIO_INSTRUCTIONS[kind]}${own}` : own;
  // Audio scenes took any positive length; audio nodes start at 0.1 seconds.
  const duration = typeof rest.durationSeconds === "number" && rest.durationSeconds < 0.1 ? { durationSeconds: 0.1 } : {};
  return { ...rest, prompt, ...duration, ...(oldModel(rest.model) ? { model: currentAudioModel(rest.model) } : {}) };
}

type NodeRecord = { id?: unknown; type: string; data?: Data };
const record = (node: unknown): node is NodeRecord => Boolean(node && typeof node === "object" && typeof (node as { type?: unknown }).type === "string");
const legacyType = (node: unknown): node is NodeRecord => record(node) && node.type in NODE_KINDS;
const droppedFields = (node: unknown): node is NodeRecord =>
  record(node) && node.type === "audio" && Boolean(node.data && typeof node.data === "object" && (DROPPED.some((key) => key in node.data!) || oldModel(node.data.model)));

/** Reads each speech, sound-effect, music or audio-scene node as an audio node, drops audio references and subtitles, and moves Seed Audio under Doubao Speech. */
export function migrateLegacyAudioNodes<T>(value: T): { value: T; migrated: string[] } {
  const nodes = value && typeof value === "object" ? (value as { nodes?: unknown }).nodes : undefined;
  const changes = (node: unknown) => legacyType(node) || droppedFields(node);
  if (!Array.isArray(nodes) || !nodes.some(changes)) return { value, migrated: [] };
  const migrated: string[] = [];
  return {
    value: { ...value, nodes: nodes.map((node) => {
      if (legacyType(node)) {
        migrated.push(String(node.id));
        return { ...node, type: "audio", data: audioData(NODE_KINDS[node.type]!, node.data ?? {}) };
      }
      if (!droppedFields(node)) return node;
      migrated.push(String(node.id));
      const data = Object.fromEntries(Object.entries(node.data!).filter(([key]) => !(DROPPED as readonly string[]).includes(key)));
      return { ...node, data: oldModel(data.model) ? { ...data, model: currentAudioModel(data.model) } : data };
    }) },
    migrated,
  };
}

/** Reads a job or run of a per-kind audio tool as `generate-audio`, keeping the kind so a retry picks a fitting model; a Seed Audio choice moves under Doubao Speech. */
export function migrateLegacyAudioJob<T extends { toolId?: unknown; input?: unknown }>(record: T): T {
  const kind = typeof record.toolId === "string" ? TOOL_KINDS[record.toolId] : undefined;
  if (!kind) {
    const input = record.input as { model?: unknown } | undefined;
    return record.toolId === "generate-audio" && oldModel(input?.model) ? { ...record, input: { ...input, model: currentAudioModel(input.model) } } : record;
  }
  const input = record.input && typeof record.input === "object" ? { input: { ...audioData(kind, record.input as Data), kind } } : {};
  return { ...record, toolId: "generate-audio", ...input };
}
