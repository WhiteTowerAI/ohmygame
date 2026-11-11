import { useEffect, useRef, useState } from "react";
import {
  type AudioSettings,
  type AudioVoice,
  type AudioModel,
  type AudioModelCapabilities,
  type AudioOutputFormat,
  type AudioSampleRate,
  DOUBAO_TTS_DIALECTS,
  findVolcengineTtsVoice,
} from "../shared/audio.js";
import { listAudioVoices, MODELS_CHANGED_EVENT } from "./api.js";
import { DoubaoVoiceOptions, DoubaoVoiceSample, VoiceSample } from "./doubao-voices.js";
import { ChevronDown } from "./icons.js";
import { language as uiLanguage, t } from "./i18n.js";
import { Disclosure } from "./ui/index.js";

const languageNames = new Intl.DisplayNames([uiLanguage], { type: "language" });

/** Saved options the model cannot send; they stay on the node until cleared. */
function hasUnsupportedOptions(
  value: AudioSettings,
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
  value: AudioSettings,
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

/** Voices listed from the provider's account, searched and paged on demand. */
function ProviderVoicePicker({
  provider,
  value,
  onChange,
  compact = false,
}: {
  provider: string;
  value?: string;
  onChange(voiceId: string | undefined): void;
  compact?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [voices, setVoices] = useState<AudioVoice[]>([]);
  const [next, setNext] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const changed = () => setRefresh((count) => count + 1);
    window.addEventListener(MODELS_CHANGED_EVENT, changed);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, changed);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      listAudioVoices(provider, { search: search.trim() || undefined }).then(
        (page) => {
          if (!active) return;
          setVoices(page.voices);
          setNext(page.nextPageToken);
          setError(undefined);
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        },
      ).finally(() => {
        if (active) setLoading(false);
      });
    }, search ? 300 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [provider, search, refresh]);
  const loadMore = () => {
    if (!next) return;
    setLoading(true);
    listAudioVoices(provider, { search: search.trim() || undefined, pageToken: next }).then(
      (page) => {
        setVoices((current) => [...current, ...page.voices.filter((voice) => !current.some((known) => known.id === voice.id))]);
        setNext(page.nextPageToken);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setLoading(false));
  };
  // A saved voice outside the loaded page stays selectable by id.
  const missing = value && !voices.some((voice) => voice.id === value);
  if (compact) return (
    <div className="canvas-chip audio-quick-voice" title={t("assetCanvas.voice.label")}>
      <select aria-label={t("assetCanvas.voice.label")} value={value ?? ""} disabled={loading} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">{t("assetCanvas.voice.choose")}</option>
        {missing ? <option value={value}>{value}</option> : null}
        {voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
      </select>
      <ChevronDown className="audio-quick-chevron" size={12} aria-hidden="true" />
      <VoiceSample url={voices.find((voice) => voice.id === value)?.previewUrl} className="audio-icon-button" />
    </div>
  );
  return (
    <div className="audio-control-wide audio-provider-voices">
      <label className="audio-voice-picker">
        {t("assetCanvas.voice.label")}
        <span>
          <select value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)}>
            <option value="">{t("assetCanvas.voice.choose")}</option>
            {missing ? <option value={value}>{value}</option> : null}
            {voices.map((voice) => (
              <option key={voice.id} value={voice.id}>{voice.name}</option>
            ))}
          </select>
          <VoiceSample url={voices.find((voice) => voice.id === value)?.previewUrl} className="audio-icon-button" />
        </span>
      </label>
      <input
        type="search"
        aria-label={t("assetCanvas.voice.search")}
        placeholder={t("assetCanvas.voice.search")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {next ? (
        <button type="button" disabled={loading} onClick={loadMore}>{t("assetCanvas.voice.more")}</button>
      ) : null}
      {error ? <p role="alert">{t("assetCanvas.voice.loadFailed", { error })}</p> : null}
    </div>
  );
}

/** The controls people commonly change while generating. Less frequent options live behind the tune icon. */
export function CanvasAudioQuickControls({ value, model, listsVoices, disabled, onChange }: {
  value: AudioSettings;
  model?: AudioModel;
  listsVoices?: boolean;
  disabled?: boolean;
  onChange(value: Partial<AudioSettings>): void;
}) {
  const [speedOpen, setSpeedOpen] = useState(false);
  const speedMenu = useRef<HTMLDivElement>(null);
  // Like a menu, the slider closes on a press anywhere else or on Escape.
  useEffect(() => {
    if (!speedOpen) return;
    const press = (event: PointerEvent) => {
      if (!speedMenu.current?.contains(event.target as Node)) setSpeedOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSpeedOpen(false);
    };
    // Capture, since the canvas stops presses on its nodes and background from bubbling.
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key);
    };
  }, [speedOpen]);
  const caps = model?.capabilities;
  const speaks = Boolean(caps?.produces.includes("speech"));
  const min = caps?.speedRange?.[0] ?? -50, max = caps?.speedRange?.[1] ?? 100;
  const speedLabel = `${(1 + (value.speed ?? 0) / 100).toFixed(1)}×`;
  return <>
    {caps?.supportsSpeaker && listsVoices && model ? <ProviderVoicePicker compact provider={model.provider} value={value.voiceId} onChange={(voiceId) => onChange({ voiceId, voiceKind: undefined, voiceModel: undefined })} /> : null}
    {caps?.supportsSpeaker && !listsVoices ? <div className="canvas-chip audio-quick-voice" title={t("assetCanvas.voice.label")}>
      <select aria-label={t("assetCanvas.voice.label")} value={value.voiceId ?? ""} disabled={disabled} onChange={(event) => onChange({ voiceId: event.target.value || undefined, voiceKind: "preset", voiceModel: undefined })}>
        <option value="">{t("assetCanvas.voice.default")}</option>
        <DoubaoVoiceOptions />
      </select>
      <ChevronDown className="audio-quick-chevron" size={12} aria-hidden="true" />
      <DoubaoVoiceSample voiceId={value.voiceId} className="audio-icon-button" />
    </div> : null}
    {speaks ? <div ref={speedMenu} className="audio-quick-speed-menu nodrag nowheel">
      <button className="canvas-chip audio-quick-speed" type="button" disabled={disabled} title={t("audioStudio.speed")} aria-label={`${t("audioStudio.speed")} ${speedLabel}`} aria-expanded={speedOpen} onPointerDown={(event) => event.stopPropagation()} onClick={() => setSpeedOpen((open) => !open)}>
        <span>{speedLabel}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {speedOpen ? <div className="audio-quick-speed-popover">
        <span>{t("audioStudio.speed")}</span>
        <input
          aria-label={t("audioStudio.speed")}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value.speed ?? 0}
          disabled={disabled}
          onChange={(event) => onChange({ speed: Number(event.target.value) })}
        />
        <output>{speedLabel}</output>
      </div> : null}
    </div> : null}
  </>;
}

export function CanvasAudioControls({
  value,
  model,
  listsVoices,
  disabled,
  onChange,
  quick = false,
  inline = false,
}: {
  value: AudioSettings;
  model?: AudioModel;
  /** The model's provider lists voices from its account instead of the built-in presets. */
  listsVoices?: boolean;
  disabled?: boolean;
  onChange(value: Partial<AudioSettings>): void;
  /** Speaker and speed are already shown in the node's compact control row. */
  quick?: boolean;
  /** Expand directly beneath the node controls instead of opening a floating panel. */
  inline?: boolean;
}) {
  const [customVoice, setCustomVoice] = useState(false);
  const caps = model?.capabilities,
    tts = Boolean(caps?.supportsSpeechOptions),
    // Speed and language shape spoken delivery; sound-effect and music-only models ignore them.
    speaks = !caps || caps.produces.includes("speech");
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
  const fields = <fieldset disabled={disabled}>
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
        {!quick && caps?.supportsSpeaker && listsVoices && model ? (
          <ProviderVoicePicker
            provider={model.provider}
            value={value.voiceId}
            onChange={(voiceId) => onChange({ voiceId, voiceKind: undefined, voiceModel: undefined })}
          />
        ) : !quick && caps?.supportsSpeaker ? (
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
          {!quick && speaks ? control("speed", caps?.speedRange?.[0] ?? -50, caps?.speedRange?.[1] ?? 100, t("audioStudio.speed")) : null}
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
        {speaks ? <label>
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
        </label> : null}
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
          <Disclosure className="audio-advanced-options audio-control-wide" summary={t("audioStudio.speechOptions")}>
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
          </Disclosure>
        ) : null}
      </fieldset>;
  if (inline) return <section className="canvas-audio-options is-inline nodrag nopan nokey"><h3>{t("audioStudio.options")}</h3>{fields}</section>;
  return <Disclosure variant="section" className="canvas-audio-options nodrag nopan nokey" summary={t("audioStudio.options")}>{fields}</Disclosure>;
}
