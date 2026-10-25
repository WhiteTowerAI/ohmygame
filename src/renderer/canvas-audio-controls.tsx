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
  type AudioOutputFormat,
  type AudioSampleRate,
  VOLCENGINE_TTS_VOICES,
} from "../shared/audio.js";
import { encodeAudioClip } from "./audio-clip.js";
import { downloadAssetBlob } from "./library-assets.js";
import { t } from "./i18n.js";

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
export function audioSettingsIssue(
  value: AudioCanvasSettings,
  model?: AudioModel,
): string | undefined {
  if (!model) return;
  const references = value.audioReferences ?? [],
    images = references.filter((item) => item.type === "image"),
    audios = references.filter((item) => item.type === "audio");
  if (
    (images.length && !model.capabilities.supportsReferenceImage) ||
    (audios.length && !model.capabilities.supportsReferenceAudio)
  )
    return t("audioStudio.incompatibleReferences");
  if (
    images.length > (model.capabilities.maxReferenceImages ?? 0) ||
    audios.length > (model.capabilities.maxReferenceAudio ?? 0) ||
    (model.capabilities.referenceModesExclusive &&
      ((images.length && (audios.length || value.voiceId)) ||
        (audios.length && value.voiceId)))
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
  if (
    model.protocol === "volcengine-seed-audio-v3" &&
    (value.ssml ||
      value.pronunciation?.length ||
      value.autoLanguage ||
      value.dialect ||
      value.voiceModel ||
      value.silenceMs ||
      value.sectionId ||
      value.output?.bitRate)
  )
    return t("audioStudio.ttsOnly");
  if (value.ssml && value.pronunciation?.length)
    return t("audioStudio.ssmlDictionary");
  if (
    model.protocol === "volcengine-tts-v3" &&
    value.voiceKind === "cloned" &&
    value.style
  )
    return t("audioStudio.clonedStyle");
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
    tts = model?.protocol === "volcengine-tts-v3";
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
        {!tts &&
        model &&
        (value.ssml ||
          value.pronunciation?.length ||
          value.autoLanguage ||
          value.dialect ||
          value.voiceModel ||
          value.silenceMs ||
          value.sectionId ||
          value.output?.bitRate) ? (
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
            <label>
              {t("assetCanvas.voice.label")}
              <select
                value={
                  value.voiceId &&
                  VOLCENGINE_TTS_VOICES.some(
                    (voice) => voice.id === value.voiceId,
                  )
                    ? value.voiceId
                    : ""
                }
                onChange={(event) =>
                  onChange({
                    voiceId: event.target.value || undefined,
                    voiceKind: "preset",
                    voiceModel: undefined,
                  })
                }
              >
                <option value="">{t("assetCanvas.voice.default")}</option>
                {VOLCENGINE_TTS_VOICES.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
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
            {tts ? (
              <label>
                {t("audioStudio.voiceKind")}
                <select
                  value={value.voiceKind ?? "preset"}
                  onChange={(event) =>
                    onChange({
                      voiceKind: event.target.value as "preset" | "cloned",
                    })
                  }
                >
                  <option value="preset">{t("audioStudio.preset")}</option>
                  <option value="cloned">{t("audioStudio.cloned")}</option>
                </select>
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
                  <option value="standard">Standard</option>
                  <option value="expressive">Expressive</option>
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        {control("speed", -50, 100, t("audioStudio.speed"))}
        {caps?.supportsPitch
          ? control("pitch", -12, 12, t("audioStudio.pitch"))
          : null}
        {caps?.supportsVolume
          ? control("volume", -50, 100, t("audioStudio.volume"))
          : null}
        {caps?.supportsStyle ? (
          <label>
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
                {language}
              </option>
            ))}
          </select>
        </label>
        {tts ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={value.autoLanguage ?? false}
                onChange={(event) =>
                  onChange({ autoLanguage: event.target.checked })
                }
              />
              {t("audioStudio.autoLanguage")}
            </label>
            <label>
              {t("audioStudio.dialect")}
              <select
                value={value.dialect ?? ""}
                onChange={(event) =>
                  onChange({ dialect: event.target.value || undefined })
                }
              >
                <option value="">{t("assetCanvas.automatic")}</option>
                {[
                  "beijing",
                  "dongbei",
                  "henan",
                  "shaanxi",
                  "shanghai",
                  "sichuan",
                  "tianjin",
                  "yue",
                ].map((dialect) => (
                  <option key={dialect} value={dialect}>
                    {t(
                      `audioStudio.dialects.${dialect}` as "audioStudio.dialects.beijing",
                    )}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("audioStudio.pronunciation")}
              <textarea
                rows={2}
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
          </>
        ) : null}
        {tts ? (
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
        ) : null}
        {caps?.supportsAlignment ? (
          <label>
            <input
              type="checkbox"
              checked={value.subtitles ?? false}
              onChange={(event) =>
                onChange({ subtitles: event.target.checked })
              }
            />
            {t("audioStudio.subtitles")}
            {caps.subtitleLanguages ? (
              <small>{t("audioStudio.subtitleLanguages")}</small>
            ) : null}
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
        {referenceControls &&
        (caps?.supportsReferenceAudio ||
          caps?.supportsReferenceImage ||
          value.audioReferences?.length) ? (
          <section className="audio-reference-controls">
            <strong>{t("audioStudio.references")}</strong>
            <small>{t("audioStudio.referenceRule")}</small>
            <label>
              {t("assetCanvas.fromLibrary")}
              <select
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
            </label>
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
            <button type="button" onClick={() => input.current?.click()}>
              {t("assetCanvas.upload")}
            </button>
            {referenceControls.references.map((reference) => (
              <div key={reference.id} className="audio-reference-item">
                <span>
                  @{reference.id} · {reference.name}
                </span>
                {reference.assetId ? (
                  <AudioReferencePreview
                    assetId={reference.assetId}
                    type={reference.type}
                    read={referenceControls.read}
                  />
                ) : null}
                <div>
                  <button
                    type="button"
                    aria-label={t("audioStudio.moveUp")}
                    onClick={() => referenceControls.move(reference.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={t("audioStudio.moveDown")}
                    onClick={() => referenceControls.move(reference.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => referenceControls.remove(reference.id)}
                  >
                    {t("audioStudio.removeReference")}
                  </button>
                  {reference.type === "audio" && reference.assetId ? (
                    <button
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
                      {t("audioStudio.selectClip")}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {clip ? (
              <section>
                <strong>{t("audioStudio.clipTitle")}</strong>
                <span>
                  {clip.name} · {clip.buffer.duration.toFixed(2)} s
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
                <button type="button" onClick={() => void saveClip()}>
                  {t("common.save")}
                </button>
                <button type="button" onClick={() => setClip(undefined)}>
                  {t("common.cancel")}
                </button>
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
