import { useEffect, useRef, useState } from "react";
import {
  findVolcengineTtsVoice,
  VOLCENGINE_TTS_VOICES,
  type VolcengineTtsVoice,
} from "../shared/audio.js";
import { language as uiLanguage, t } from "./i18n.js";
import { Play, Square } from "./icons.js";

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
  const url = findVolcengineTtsVoice(voiceId)?.trialUrl;
  const audio = useRef<HTMLAudioElement>(undefined);
  const [playing, setPlaying] = useState(false);
  useEffect(
    () => () => {
      audio.current?.pause();
      audio.current = undefined;
      setPlaying(false);
    },
    [url],
  );
  if (!url) return null;
  const label = t(
    playing ? "audioStudio.stopSample" : "audioStudio.playSample",
  );
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      onClick={() => {
        if (playing) {
          audio.current?.pause();
          setPlaying(false);
          return;
        }
        audio.current ??= new Audio(url);
        audio.current.currentTime = 0;
        audio.current.onended = () => setPlaying(false);
        void audio.current.play().then(
          () => setPlaying(true),
          () => setPlaying(false),
        );
      }}
    >
      {playing ? <Square size={13} /> : <Play size={13} />}
    </button>
  );
}
