import { useEffect, useRef, useState } from "react";
import type {
  LibraryAssetDerivation,
  LibraryUploadMediaType,
} from "../shared/contracts.js";
import {
  audioCompanionFiles,
  type AudioAssetData,
  type AudioCanvasReference,
  type AudioCanvasSettings,
  type AudioModel,
  type AudioModelCapabilities,
  type AudioOutputFormat,
  type AudioSampleRate,
  DOUBAO_TTS_DIALECTS,
  findVolcengineTtsVoice,
} from "../shared/audio.js";
import { encodeAudioClip } from "./audio-clip.js";
import { DoubaoVoiceOptions, DoubaoVoiceSample } from "./doubao-voices.js";
import { downloadAssetBlob } from "./library-assets.js";
import { language as uiLanguage, t } from "./i18n.js";
import { ArrowUp, Scissors, Trash2, Upload } from "./icons.js";

const languageNames = new Intl.DisplayNames([uiLanguage], { type: "language" });

export interface AudioReferenceChoice {
  id: string;
  name: string;
  type: "audio" | "image";
}
export interface AudioReferenceView extends AudioCanvasReference {
  assetId?: string;
  name: string;
  url?: string;
}
export interface AudioReferenceControls {
  choices: AudioReferenceChoice[];
  references: AudioReferenceView[];
  add(assetId: string, type: "audio" | "image"): void;
  remove(id: string): void;
  move(id: string, direction: -1 | 1): void;
  read(assetId: string): Promise<Blob>;
  upload(
    file: File,
    mediaType: LibraryUploadMediaType,
    duration?: number,
    derivedFrom?: LibraryAssetDerivation,
  ): Promise<string>;
  replace(id: string, assetId: string): void;
}
/** Saved options the model cannot send; they stay on the node until cleared. */
function hasUnsupportedOptions(
  value: AudioCanvasSettings,
  caps: AudioModelCapabilities,
): boolean {
  return Boolean(
    (!caps.supportsSSML && value.ssml) ||
    (!caps.supportsSpeechOptions &&
      (value.pronunciation?.length ||
        value.autoLanguage ||
        value.dialect ||
        value.voiceModel ||
        value.silenceMs ||
        value.sectionId ||
        value.output?.bitRate)),
  );
}

export function audioSettingsIssue(
  value: AudioCanvasSettings,
  model?: AudioModel,
): string | undefined {
  if (!model) return;
  const caps = model.capabilities;
  const references = value.audioReferences ?? [],
    images = references.filter((item) => item.type === "image"),
    audios = references.filter((item) => item.type === "audio");
  if (
    (images.length && !caps.supportsReferenceImage) ||
    (audios.length && !caps.supportsReferenceAudio)
  )
    return t("audioStudio.incompatibleReferences");
  // A Speaker ID is one more audio-side reference when references are used.
  if (
    images.length > (caps.maxReferenceImages ?? 0) ||
    (references.length &&
      audios.length + (value.voiceId ? 1 : 0) >
        (caps.maxReferenceAudio ?? 0)) ||
    (caps.referenceModesExclusive &&
      images.length &&
      (audios.length || value.voiceId))
  )
    return t("audioStudio.referenceRule");
  if (
    (value.output?.format &&
      !model.capabilities.formats.includes(value.output.format)) ||
    (value.output?.sampleRate &&
      !(
        model.capabilities.sampleRatesByFormat?.[
          value.output.format ?? "mp3"
        ] ??
        model.capabilities.sampleRates ??
        []
      ).includes(value.output.sampleRate))
  )
    return t("audioStudio.incompatibleOutput");
  if (
    value.subtitles &&
    value.language &&
    model.capabilities.subtitleLanguages &&
    !model.capabilities.subtitleLanguages.includes(value.language)
  )
    return t("audioStudio.subtitleLanguages");
  if (hasUnsupportedOptions(value, caps)) return t("audioStudio.ttsOnly");
  if (value.ssml && value.pronunciation?.length)
    return t("audioStudio.ssmlDictionary");
  if (!caps.supportsSpeechOptions) return;
  if (value.voiceKind === "cloned" && value.style)
    return t("audioStudio.clonedStyle");
  // Only catalog presets carry these limits; custom and cloned Speaker IDs are checked by the provider.
  const voice =
    value.voiceKind === "cloned"
      ? undefined
      : findVolcengineTtsVoice(value.voiceId);
  const option =
    voice?.noInstructions && value.style
      ? t("audioStudio.style")
      : voice && !voice.dialects && value.dialect
        ? t("audioStudio.dialect")
        : voice && value.ssml && !["zh-cn", "en"].includes(voice.language)
          ? "SSML"
          : undefined;
  if (option) return t("audioStudio.voiceUnsupported", { option });
}

export function AudioCompanionDownloads({
  data,
  name = "audio",
}: {
  data?: AudioAssetData;
  name?: string;
}) {
  if (!data) return null;
  return (
    <div className="audio-companion-downloads nodrag nopan">
      {audioCompanionFiles(name, data).map((file) => (
        <button
          key={file.name}
          type="button"
          onClick={() =>
            downloadAssetBlob(
              new Blob([file.text], { type: file.mediaType }),
              file.name,
            )
          }
        >
          {file.role === "metadata"
            ? t("audioStudio.metadata")
            : file.name.endsWith(".srt")
              ? "SRT"
              : "WebVTT"}
        </button>
      ))}
    </div>
  );
}

export function CanvasAudioControls({
  value,
  model,
  disabled,
  onChange,
  referenceControls,
}: {
  value: AudioCanvasSettings;
  model?: AudioModel;
  disabled?: boolean;
  onChange(value: Partial<AudioCanvasSettings>): void;
  referenceControls?: AudioReferenceControls;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [customVoice, setCustomVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [clip, setClip] = useState<{
    buffer: AudioBuffer;
    originalId: string;
    name: string;
    replaceId?: string;
  }>();
  const [start, setStart] = useState(0),
    [end, setEnd] = useState(0);
  const caps = model?.capabilities,
    tts = Boolean(caps?.supportsSpeechOptions);
  const preset = findVolcengineTtsVoice(value.voiceId);
  const usesCustomVoice =
    customVoice ||
    Boolean(value.voiceId && !preset) ||
    value.voiceKind === "cloned";
  const control = (
    key: "speed" | "pitch" | "volume",
    min: number,
    max: number,
    label: string,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        title={`${min} … ${max}`}
        value={value[key] ?? 0}
        onChange={(event) => onChange({ [key]: Number(event.target.value) })}
      />
    </label>
  );
  async function decode(
    blob: Blob,
    name: string,
    originalId: string,
    replaceId?: string,
  ) {
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      setClip({ buffer, originalId, name, replaceId });
      setStart(0);
      setEnd(Math.min(30, buffer.duration));
    } finally {
      await context.close();
    }
  }
  async function upload(file: File) {
    if (!referenceControls) return;
    setError(undefined);
    setBusy(true);
    try {
      if (file.size > 100 * 1024 * 1024)
        throw new Error(t("audioStudio.sourceTooLarge"));
      const image = file.type.startsWith("image/");
      const id = await referenceControls.upload(
        file,
        file.type as LibraryUploadMediaType,
      );
      if (image) referenceControls.add(id, "image");
      else await decode(file, file.name, id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function saveClip() {
    if (!clip || !referenceControls) return;
    setError(undefined);
    setBusy(true);
    try {
      if (
        start < 0 ||
        end <= start ||
        end > clip.buffer.duration ||
        end - start > 30
      )
        throw new Error(t("audioStudio.clipInvalid"));
      const blob = encodeAudioClip(
        Array.from(
          { length: Math.min(2, clip.buffer.numberOfChannels) },
          (_, i) => clip.buffer.getChannelData(i),
        ),
        clip.buffer.sampleRate,
        start,
        end,
      );
      if (blob.size > 10 * 1024 * 1024)
        throw new Error(t("audioStudio.clipTooLarge"));
      const id = await referenceControls.upload(
        new File([blob], `${clip.name.replace(/\.[^.]+$/, "")}-clip.wav`, {
          type: "audio/wav",
        }),
        "audio/wav",
        end - start,
        { assetId: clip.originalId, trim: { start, end } },
      );
      if (clip.replaceId) referenceControls.replace(clip.replaceId, id);
      else referenceControls.add(id, "audio");
      setClip(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="canvas-audio-options nodrag nopan nokey">
      <summary>{t("audioStudio.options")}</summary>
      <fieldset disabled={disabled || busy}>
        {caps && hasUnsupportedOptions(value, caps) ? (
          <button
            type="button"
            onClick={() =>
              onChange({
                ssml: undefined,
                pronunciation: undefined,
                autoLanguage: undefined,
                dialect: undefined,
                voiceModel: undefined,
                silenceMs: undefined,
                sectionId: undefined,
                output: { ...value.output, bitRate: undefined },
              })
            }
          >
            {t("audioStudio.clearUnsupported")}
          </button>
        ) : null}
        {caps?.supportsSpeaker ? (
          <>
            <label className="audio-control-wide audio-voice-picker">
              {t("assetCanvas.voice.label")}
              <span>
                <select
                  value={
                    usesCustomVoice
                      ? value.voiceKind === "cloned" && tts
                        ? "__cloned"
                        : "__custom"
                      : (value.voiceId ?? "")
                  }
                  onChange={(event) => {
                    const mode = event.target.value;
                    const custom = mode === "__custom" || mode === "__cloned";
                    setCustomVoice(custom);
                    onChange({
                      voiceId: custom ? undefined : mode || undefined,
                      voiceKind: mode === "__cloned" ? "cloned" : "preset",
                      voiceModel: undefined,
                    });
                  }}
                >
                  <option value="">{t("assetCanvas.voice.default")}</option>
                  <DoubaoVoiceOptions />
                  <option value="__custom">
                    {t("providers.voiceSelectCustom")}
                  </option>
                  {tts ? (
                    <option value="__cloned">{t("audioStudio.cloned")}</option>
                  ) : null}
                </select>
                {usesCustomVoice ? null : (
                  <DoubaoVoiceSample
                    voiceId={value.voiceId}
                    className="audio-icon-button"
                  />
                )}
              </span>
            </label>
            {usesCustomVoice ? (
              <label className="audio-control-wide">
                {t("providers.voiceIdInputLabel")}
                <input
                  value={value.voiceId ?? ""}
                  maxLength={256}
                  onChange={(event) =>
                    onChange({ voiceId: event.target.value || undefined })
                  }
                  placeholder={t("providers.defaultVoiceIdPlaceholder")}
                />
              </label>
            ) : null}
            {tts && value.voiceKind === "cloned" ? (
              <label>
                {t("audioStudio.voiceModel")}
                <select
                  value={value.voiceModel ?? "standard"}
                  onChange={(event) =>
                    onChange({
                      voiceModel: event.target.value as
                        "standard" | "expressive",
                    })
                  }
                >
                  <option value="standard">
                    {t("audioStudio.standardVoice")}
                  </option>
                  <option value="expressive">
                    {t("audioStudio.expressiveVoice")}
                  </option>
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        <div className="audio-control-adjustments">
          {control("speed", -50, 100, t("audioStudio.speed"))}
          {caps?.supportsPitch
            ? control("pitch", -12, 12, t("audioStudio.pitch"))
            : null}
          {caps?.supportsVolume
            ? control("volume", -50, 100, t("audioStudio.volume"))
            : null}
        </div>
        {caps?.supportsStyle && !(preset?.noInstructions && !value.style) ? (
          <label className="audio-control-wide">
            {t("audioStudio.style")}
            <textarea
              rows={2}
              value={value.style ?? ""}
              onChange={(event) =>
                onChange({ style: event.target.value || undefined })
              }
            />
          </label>
        ) : null}
        <label>
          {t("audioStudio.language")}
          <select
            value={value.language ?? ""}
            onChange={(event) =>
              onChange({ language: event.target.value || undefined })
            }
          >
            <option value="">{t("assetCanvas.automatic")}</option>
            {caps?.languages?.map((language) => (
              <option key={language} value={language}>
                {languageNames.of(language)}
              </option>
            ))}
          </select>
        </label>
        {caps?.supportsAlignment ? (
          <label className="audio-checkbox">
            <input
              type="checkbox"
              checked={value.subtitles ?? false}
              onChange={(event) =>
                onChange({ subtitles: event.target.checked })
              }
            />
            {t("audioStudio.subtitles")}
          </label>
        ) : null}
        <label>
          {t("audioStudio.format")}
          <select
            value={value.output?.format ?? "mp3"}
            onChange={(event) =>
              onChange({
                output: { format: event.target.value as AudioOutputFormat },
              })
            }
          >
            {caps?.formats.map((format) => (
              <option value={format} key={format}>
                {format === "ogg_opus" ? "Ogg Opus" : format.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("audioStudio.sampleRate")}
          <select
            value={value.output?.sampleRate ?? ""}
            onChange={(event) =>
              onChange({
                output: {
                  ...value.output,
                  sampleRate: event.target.value
                    ? (Number(event.target.value) as AudioSampleRate)
                    : undefined,
                },
              })
            }
          >
            <option value="">{t("assetCanvas.automatic")}</option>
            {(
              caps?.sampleRatesByFormat?.[value.output?.format ?? "mp3"] ??
              caps?.sampleRates
            )?.map((rate) => (
              <option value={rate} key={rate}>
                {rate} Hz
              </option>
            ))}
          </select>
        </label>
        {tts ? (
          <label>
            {t("audioStudio.bitRate")}
            <select
              value={value.output?.bitRate ?? ""}
              onChange={(event) =>
                onChange({
                  output: {
                    ...value.output,
                    bitRate: event.target.value
                      ? Number(event.target.value)
                      : undefined,
                  },
                })
              }
            >
              <option value="">{t("assetCanvas.automatic")}</option>
              {[16000, 32000, 64000, 160000].map((rate) => (
                <option key={rate} value={rate}>
                  {rate / 1000} kbps
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {tts ? (
          <details className="audio-advanced-options audio-control-wide">
            <summary>{t("audioStudio.speechOptions")}</summary>
            <div className="audio-control-grid">
              <label className="audio-checkbox">
                <input
                  type="checkbox"
                  checked={value.autoLanguage ?? false}
                  onChange={(event) =>
                    onChange({ autoLanguage: event.target.checked })
                  }
                />
                {t("audioStudio.autoLanguage")}
              </label>
              {!preset || preset.dialects || value.dialect ? (
                <label>
                  {t("audioStudio.dialect")}
                  <select
                    value={value.dialect ?? ""}
                    onChange={(event) =>
                      onChange({ dialect: event.target.value || undefined })
                    }
                  >
                    <option value="">{t("assetCanvas.automatic")}</option>
                    {DOUBAO_TTS_DIALECTS.map((dialect) => (
                      <option key={dialect} value={dialect}>
                        {t(
                          `audioStudio.dialects.${dialect}` as "audioStudio.dialects.beijing",
                        )}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                {t("audioStudio.pronunciation")}
                <textarea
                  rows={2}
                  placeholder={t("audioStudio.pronunciationExample")}
                  value={
                    value.pronunciation
                      ?.map((entry) => `${entry.word}/${entry.replacement}`)
                      .join("\n") ?? ""
                  }
                  onChange={(event) =>
                    onChange({
                      pronunciation: event.target.value
                        ? event.target.value.split("\n").map((line) => {
                            const at = line.indexOf("/");
                            return {
                              word: at < 0 ? line : line.slice(0, at),
                              replacement: at < 0 ? "" : line.slice(at + 1),
                            };
                          })
                        : undefined,
                    })
                  }
                />
              </label>
              {caps?.supportsSSML ? (
                <label>
                  SSML
                  <textarea
                    rows={2}
                    value={value.ssml ?? ""}
                    onChange={(event) =>
                      onChange({ ssml: event.target.value || undefined })
                    }
                  />
                </label>
              ) : null}
              <label>
                {t("audioStudio.silence")}
                <input
                  type="number"
                  min={0}
                  max={30000}
                  step={1}
                  value={value.silenceMs ?? 0}
                  onChange={(event) =>
                    onChange({ silenceMs: Number(event.target.value) })
                  }
                />
              </label>

              <label>
                {t("audioStudio.sectionId")}
                <input
                  maxLength={120}
                  value={value.sectionId ?? ""}
                  onChange={(event) =>
                    onChange({ sectionId: event.target.value || undefined })
                  }
                />
              </label>
            </div>
          </details>
        ) : null}
        {referenceControls &&
        (caps?.supportsReferenceAudio ||
          caps?.supportsReferenceImage ||
          value.audioReferences?.length) ? (
          <section className="audio-reference-controls">
            <div className="audio-reference-toolbar">
              <select
                aria-label={t("audioStudio.chooseReference")}
                value=""
                onChange={(event) => {
                  const asset = referenceControls.choices.find(
                    (asset) => asset.id === event.target.value,
                  );
                  if (asset) referenceControls.add(asset.id, asset.type);
                }}
              >
                <option value="">{t("audioStudio.chooseReference")}</option>
                {referenceControls.choices.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
              <input
                ref={input}
                type="file"
                hidden
                accept="audio/*,image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void upload(file);
                }}
              />
              <button
                type="button"
                className="audio-icon-button"
                aria-label={t("assetCanvas.upload")}
                title={t("assetCanvas.upload")}
                onClick={() => input.current?.click()}
              >
                <Upload size={15} />
              </button>
            </div>
            {referenceControls.references.map((reference, index) => (
              <div
                key={reference.id}
                className="audio-reference-item"
                role="group"
                aria-label={`@${reference.id} · ${reference.name}`}
              >
                <div className="audio-reference-heading">
                  <code>@{reference.id}</code>
                  <span title={reference.name}>{reference.name}</span>
                  <div className="audio-reference-actions">
                    <button
                      type="button"
                      className="audio-icon-button"
                      aria-label={t("audioStudio.moveUp")}
                      title={t("audioStudio.moveUp")}
                      disabled={index === 0}
                      onClick={() => referenceControls.move(reference.id, -1)}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="audio-icon-button"
                      aria-label={t("audioStudio.moveDown")}
                      title={t("audioStudio.moveDown")}
                      disabled={
                        index === referenceControls.references.length - 1
                      }
                      onClick={() => referenceControls.move(reference.id, 1)}
                    >
                      <ArrowUp
                        size={13}
                        style={{ transform: "rotate(180deg)" }}
                      />
                    </button>
                    <button
                      type="button"
                      className="audio-icon-button"
                      aria-label={t("audioStudio.removeReference")}
                      title={t("audioStudio.removeReference")}
                      onClick={() => referenceControls.remove(reference.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {reference.assetId ? (
                  <AudioReferencePreview
                    assetId={reference.assetId}
                    type={reference.type}
                    read={referenceControls.read}
                  />
                ) : null}
                {reference.type === "audio" && reference.assetId ? (
                  <button
                    className="audio-clip-button"
                    type="button"
                    onClick={() => {
                      setBusy(true);
                      setError(undefined);
                      void referenceControls
                        .read(reference.assetId!)
                        .then((blob) =>
                          decode(
                            blob,
                            reference.name,
                            reference.assetId!,
                            reference.id,
                          ),
                        )
                        .catch((cause) => setError(String(cause)))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Scissors size={13} />
                    {t("audioStudio.selectClip")}
                  </button>
                ) : null}
              </div>
            ))}
            {clip ? (
              <section
                className="audio-clip-editor"
                aria-label={t("audioStudio.clipTitle")}
              >
                <span
                  className="audio-control-wide audio-clip-name"
                  title={clip.name}
                >
                  {clip.name}
                </span>
                <label>
                  {t("audioStudio.clipStart")}
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    max={clip.buffer.duration}
                    value={start}
                    onChange={(event) => setStart(Number(event.target.value))}
                  />
                </label>
                <label>
                  {t("audioStudio.clipEnd")}
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    max={clip.buffer.duration}
                    value={end}
                    onChange={(event) => setEnd(Number(event.target.value))}
                  />
                </label>
                <div className="audio-clip-actions audio-control-wide">
                  <button type="button" onClick={() => setClip(undefined)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="audio-clip-save"
                    onClick={() => void saveClip()}
                  >
                    {t("common.save")}
                  </button>
                </div>
              </section>
            ) : null}
          </section>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
      </fieldset>
    </details>
  );
}

function AudioReferencePreview({
  assetId,
  type,
  read,
}: {
  assetId: string;
  type: "image" | "audio";
  read(id: string): Promise<Blob>;
}) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true,
      source: string | undefined;
    void read(assetId)
      .then((blob) => {
        if (active) {
          source = URL.createObjectURL(blob);
          setUrl(source);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
      if (source) URL.revokeObjectURL(source);
    };
  }, [assetId]);
  return url ? (
    type === "audio" ? (
      <audio src={url} controls preload="metadata" />
    ) : (
      <img src={url} alt="" />
    )
  ) : null;
}
