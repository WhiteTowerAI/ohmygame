import { useEffect, useRef, useState } from "react";
import {
  findVolcengineTtsVoice,
  VOLCENGINE_TTS_VOICES,
  type VolcengineTtsVoice,
} from "../shared/audio.js";
import { language as uiLanguage, t } from "./i18n.js";
import { LoaderCircle, Play, Square } from "./icons.js";

const languageNames = new Intl.DisplayNames([uiLanguage], { type: "language" });
const voicesByLanguage = VOLCENGINE_TTS_VOICES.reduce((groups, voice) => {
  groups.set(voice.language, [...(groups.get(voice.language) ?? []), voice]);
  return groups;
}, new Map<string, VolcengineTtsVoice[]>());

/** Preset voices grouped by language, in catalog order. */
export function DoubaoVoiceOptions() {
  return (
    <>
      {[...voicesByLanguage].map(([language, voices]) => (
        <optgroup key={language} label={languageNames.of(language) ?? language}>
          {voices.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

/** Plays Volcengine's hosted sample for a preset voice without using synthesis quota. */
export function DoubaoVoiceSample({
  voiceId,
  className,
}: {
  voiceId?: string;
  className?: string;
}) {
  return <VoiceSample url={findVolcengineTtsVoice(voiceId)?.trialUrl} className={className} />;
}

/** Plays a provider's hosted voice sample; it spends no generation quota. */
export function VoiceSample({
  url,
  className,
}: {
  url?: string;
  className?: string;
}) {
  const audio = useRef<HTMLAudioElement>(undefined);
  // The sample downloads on the first press, which can take a while, so the
  // button says so instead of looking as if nothing happened.
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = undefined;
      setState("idle");
    },
    [url],
  );
  if (!url) return null;
  const label = t(
    state === "playing" ? "audioStudio.stopSample"
      : state === "loading" ? "audioStudio.loadingSample"
      : state === "failed" ? "audioStudio.sampleFailed"
      : "audioStudio.playSample",
  );
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      aria-busy={state === "loading" || undefined}
      data-state={state}
      onClick={() => {
        // A press while it loads or plays stops it.
        if (state === "playing" || state === "loading") {
          audio.current?.pause();
          setState("idle");
          return;
        }
        const sample = (audio.current ??= new Audio(url));
        sample.currentTime = 0;
        sample.onended = () => setState("idle");
        setState("loading");
        void sample.play().then(
          () => { if (audio.current === sample && !sample.paused) setState("playing"); },
          (cause: unknown) => {
            if (audio.current !== sample) return;
            // Stopped by the person before it started: not a failure.
            if (cause instanceof DOMException && cause.name === "AbortError") return setState("idle");
            // A failed element stays failed, so a retry downloads afresh.
            audio.current = undefined;
            setState("failed");
          },
        );
      }}
    >
      {state === "playing" ? <Square size={13} /> : state === "loading" ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}
    </button>
  );
}
