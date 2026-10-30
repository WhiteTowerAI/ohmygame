import {
  AUDIO_OUTPUT_FORMATS,
  AUDIO_SAMPLE_RATES,
  AUDIO_VOICE_ID_MAX_LENGTH,
  AUDIO_VOICE_ID_PATTERN,
  DOUBAO_TTS_DIALECTS,
} from "./audio.js";

const text = { type: "string", minLength: 1, maxLength: 120 } as const;
export const AUDIO_SETTINGS_PROPERTIES = {
  voiceId: {
    type: "string",
    minLength: 1,
    maxLength: AUDIO_VOICE_ID_MAX_LENGTH,
    pattern: AUDIO_VOICE_ID_PATTERN,
  },
  voiceKind: { enum: ["preset", "cloned"] },
  voiceModel: { enum: ["standard", "expressive"] },
  language: { type: "string", minLength: 1, maxLength: 40 },
  autoLanguage: { type: "boolean" },
  dialect: { enum: DOUBAO_TTS_DIALECTS },
  style: { type: "string", maxLength: 2000 },
  speed: { type: "integer", minimum: -50, maximum: 100 },
  pitch: { type: "integer", minimum: -12, maximum: 12 },
  volume: { type: "integer", minimum: -50, maximum: 100 },
  ssml: { type: "string", maxLength: 10_000 },
  pronunciation: {
    type: "array",
    maxItems: 5000,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["word", "replacement"],
      properties: {
        word: {
          type: "string",
          minLength: 1,
          maxLength: 9,
          pattern: "^[^\\s/]+$",
        },
        replacement: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  },
  silenceMs: { type: "integer", minimum: 0, maximum: 30_000 },
  sectionId: text,
  output: {
    type: "object",
    additionalProperties: false,
    properties: {
      format: { enum: AUDIO_OUTPUT_FORMATS },
      sampleRate: { enum: AUDIO_SAMPLE_RATES },
      channels: { enum: [1, 2] },
      bitRate: { enum: [16_000, 32_000, 64_000, 160_000] },
    },
  },
} as const;
