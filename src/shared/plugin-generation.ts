// A plugin's use of the image and audio models the person set up in
// OhMyGame (`capabilities.media`, API 2.38.0). A page asks with
// `host.media`; `src/daemon/plugin-generation.ts` runs each request the way the
// app's own generation does, so what it makes lands in the person's Library
// too, and checks it with `readPluginGenerationRequest`.

import { AUDIO_KINDS, AUDIO_PROMPT_MAX_LENGTH, AUDIO_VOICE_ID_MAX_LENGTH, type AudioKind } from "./audio.js";
import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_MAX_REFERENCE_IMAGES,
  IMAGE_OUTPUT_COUNTS,
  IMAGE_RESOLUTIONS,
  type ImageAspectRatio,
  type ImageOutputCount,
  type ImageResolution,
} from "./contracts.js";

export type PluginGenerationKind = "image" | "audio";

/** An image to work from: base64 data and its media type. */
export interface PluginGenerationImage {
  data: string;
  type: "image/png" | "image/jpeg" | "image/webp";
}

export type PluginGenerationRequest =
  | {
    media: "image";
    prompt: string;
    /** One of `media.models("image")`; the default model when left out. */
    model?: { provider: string; id: string };
    /** Either alone is enough: the other is the model's nearest. */
    resolution?: ImageResolution;
    aspectRatio?: ImageAspectRatio;
    /** How many images, 1 to 4. */
    outputs?: ImageOutputCount;
    transparentBackground?: boolean;
    /** Images to work from, for a model that takes them. */
    images?: PluginGenerationImage[];
  }
  | {
    media: "audio";
    /** The words a speech model says, or a description of the sound or music. */
    prompt: string;
    /** One of `media.models("audio")`; when left out, the default for `kind`. */
    model?: { provider: string; id: string };
    kind?: AudioKind;
    durationSeconds?: number;
    loop?: boolean;
    instrumental?: boolean;
    voiceId?: string;
  };

/** A file a request made, as base64; the page hears it as a Blob. */
export interface PluginGenerationFile {
  name: string;
  type: string;
  data: string;
  /** Where the person finds it in their Library. */
  assetId?: string;
}

export interface PluginGenerationResult {
  model?: { provider: string; id: string };
  files: PluginGenerationFile[];
}

export const PLUGIN_GENERATION_LIMITS = {
  /** How many requests of one plugin run at once, and in a minute. */
  concurrent: 2,
  perMinute: 10,
  /** Each image to work from, as base64. */
  imageChars: 7_000_000,
  imagePrompt: 32_000,
} as const;

/** The most one image to work from may be before it is base64, which grows it by a third. */
export const PLUGIN_GENERATION_IMAGE_MAX_BYTES = Math.floor(PLUGIN_GENERATION_LIMITS.imageChars / 4) * 3;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const NAME = /^[A-Za-z0-9._:/@+-]{1,200}$/;
const VOICE = /^[A-Za-z0-9_-]+$/;

/** Checks a request from a plugin, returning it or why it is refused. */
export function readPluginGenerationRequest(value: unknown): { ok: true; request: PluginGenerationRequest } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("A media request is an object");
  const { media, prompt, model, ...rest } = value as Record<string, unknown>;
  if (media !== "image" && media !== "audio") return fail("media is image or audio");
  const longest = media === "image" ? PLUGIN_GENERATION_LIMITS.imagePrompt : AUDIO_PROMPT_MAX_LENGTH;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > longest)
    return fail(`prompt is text of 1 to ${longest.toLocaleString("en")} characters`);
  let chosen: { provider: string; id: string } | undefined;
  if (model !== undefined) {
    const { provider, id } = (model ?? {}) as Record<string, unknown>;
    if (typeof provider !== "string" || !NAME.test(provider) || typeof id !== "string" || !NAME.test(id))
      return fail(`model is { provider, id }, one of media.models("${media}")`);
    chosen = { provider, id };
  }
  const allowed = media === "image"
    ? ["resolution", "aspectRatio", "outputs", "transparentBackground", "images"]
    : ["kind", "durationSeconds", "loop", "instrumental", "voiceId"];
  const other = Object.keys(rest).find((key) => !allowed.includes(key));
  if (other) return fail(`An ${media} request has no ${other}`);
  const base = { prompt, ...(chosen ? { model: chosen } : {}) };
  if (media === "audio") {
    const { kind, durationSeconds, loop, instrumental, voiceId } = rest;
    if (kind !== undefined && !(AUDIO_KINDS as readonly unknown[]).includes(kind)) return fail(`kind is ${AUDIO_KINDS.join(", ")}`);
    if (durationSeconds !== undefined && (typeof durationSeconds !== "number" || !(durationSeconds >= 0.1 && durationSeconds <= 600)))
      return fail("durationSeconds is a number from 0.1 to 600");
    if (loop !== undefined && typeof loop !== "boolean") return fail("loop is true or false");
    if (instrumental !== undefined && typeof instrumental !== "boolean") return fail("instrumental is true or false");
    if (voiceId !== undefined && (typeof voiceId !== "string" || !voiceId || voiceId.length > AUDIO_VOICE_ID_MAX_LENGTH || !VOICE.test(voiceId)))
      return fail("voiceId is letters, digits, dashes or underscores");
    return {
      ok: true,
      request: {
        media, ...base,
        ...(kind !== undefined ? { kind: kind as AudioKind } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(instrumental !== undefined ? { instrumental } : {}),
        ...(voiceId !== undefined ? { voiceId } : {}),
      },
    };
  }
  const { resolution, aspectRatio, outputs, transparentBackground, images } = rest;
  if (resolution !== undefined && !(IMAGE_RESOLUTIONS as readonly unknown[]).includes(resolution)) return fail(`resolution is ${IMAGE_RESOLUTIONS.join(", ")}`);
  if (aspectRatio !== undefined && !(IMAGE_ASPECT_RATIOS as readonly unknown[]).includes(aspectRatio)) return fail(`aspectRatio is ${IMAGE_ASPECT_RATIOS.join(", ")}`);
  if (outputs !== undefined && !(IMAGE_OUTPUT_COUNTS as readonly unknown[]).includes(outputs)) return fail(`outputs is ${IMAGE_OUTPUT_COUNTS.join(", ")}`);
  if (transparentBackground !== undefined && typeof transparentBackground !== "boolean") return fail("transparentBackground is true or false");
  let read: PluginGenerationImage[] | undefined;
  if (images !== undefined) {
    if (!Array.isArray(images) || images.length > IMAGE_MAX_REFERENCE_IMAGES) return fail(`images is a list of at most ${IMAGE_MAX_REFERENCE_IMAGES}`);
    read = [];
    for (const image of images as unknown[]) {
      const { data, type } = (image ?? {}) as Record<string, unknown>;
      if (typeof type !== "string" || !IMAGE_TYPES.has(type)) return fail("an image's type is image/png, image/jpeg or image/webp");
      if (typeof data !== "string" || !data.length || data.length > PLUGIN_GENERATION_LIMITS.imageChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
        return fail(`an image's data is base64 of at most ${PLUGIN_GENERATION_LIMITS.imageChars.toLocaleString("en")} characters`);
      read.push({ data, type: type as PluginGenerationImage["type"] });
    }
  }
  // Generation takes images and several outputs only at a size the model offers, which it can find from one of them.
  if ((read?.length || outputs !== undefined) && resolution === undefined && aspectRatio === undefined)
    return fail("With images or outputs, give an aspectRatio or a resolution, one the model offers in media.models(\"image\")");
  return {
    ok: true,
    request: {
      media, ...base,
      ...(resolution !== undefined ? { resolution: resolution as ImageResolution } : {}),
      ...(aspectRatio !== undefined ? { aspectRatio: aspectRatio as ImageAspectRatio } : {}),
      ...(outputs !== undefined ? { outputs: outputs as ImageOutputCount } : {}),
      ...(transparentBackground ? { transparentBackground: true } : {}),
      ...(read?.length ? { images: read } : {}),
    },
  };
}
