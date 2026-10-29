import { useState } from "react";
import {
  type AudioCanvasSettings,
  type AudioModel,
  type AudioModelCapabilities,
  type AudioOutputFormat,
  type AudioSampleRate,
  DOUBAO_TTS_DIALECTS,
  findVolcengineTtsVoice,
} from "../shared/audio.js";
import { DoubaoVoiceOptions, DoubaoVoiceSample } from "./doubao-voices.js";
import { language as uiLanguage, t } from "./i18n.js";

const languageNames = new Intl.DisplayNames([uiLanguage], { type: "language" });

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

export function CanvasAudioControls({
  value,
  model,
  disabled,
  onChange,
}: {
  value: AudioCanvasSettings;
  model?: AudioModel;
  disabled?: boolean;
  onChange(value: Partial<AudioCanvasSettings>): void;
}) {
  const [customVoice, setCustomVoice] = useState(false);
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
  return (
    <details className="canvas-audio-options nodrag nopan nokey">
      <summary>{t("audioStudio.options")}</summary>
      <fieldset disabled={disabled}>
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
      </fieldset>
    </details>
  );
}
