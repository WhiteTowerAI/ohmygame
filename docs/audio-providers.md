# Audio providers

Audio works like image and video: one request carries a model, a prompt and
the options that model takes. Speech, sound effects and music share model
selection, jobs, Library storage, and project export. The daemon owns
credentials and provider calls. Canvas and agents submit the same
provider-neutral request.

## Providers and connection settings

**Settings → Providers** lists **Doubao Speech**, **Doubao Seed Audio**, and
**ElevenLabs**. ElevenLabs uses one account API key for speech, sound effects,
music and transcription. Its voices are listed from the account rather than
built in. The key is kept by the daemon and is never written to canvas files.

Each layer stays separate:

- **Requests** (`AudioGenerationRequest`) are `model`, `prompt`, an optional
  `kind` hint (`speech`, `sound-effect` or `music`), `durationSeconds`,
  `loop`, `instrumental` and the audio settings. There is no operation: the
  model decides how to read the prompt.
- **Models** declare what they make and their limits in `capabilities`:
  `produces` lists the kinds, `readsText` means the prompt is spoken word for
  word, and `transcribes` marks a speech-to-text model. The UI and validation
  read those instead of checking a provider ID. `requiresVoice` means speech
  needs a voice from the provider's list, `speedRange` narrows the shared
  speed scale, and `minDurationSeconds`/`maxDurationSeconds` bound generated
  length.
- **Adapters** (`AudioProviderAdapter`) translate one provider's API. They may
  also list account voices (`voices`) and transcribe audio (`transcribe`).
- **One canvas node and one tool**: the `audio` node and `generate-audio`
  (`generate_audio` for agents). Without a model, `kind` picks a ready model
  that makes it, preferring a `readsText` model for speech. Options the model
  doesn't take are dropped before the adapter sees them. Transcription is a
  media tool on an audio node, not a node of its own.

Doubao Speech and Doubao Seed Audio remain separate providers. Each has its
own API key, enable state, preview, model list and deletion action. Speech
also has a default voice setting. Saving or removing one service does not
change the other.

Existing `doubao-voice.json` credentials and migrations from earlier settings
files remain readable, including shared keys previously saved by the unified
page. New settings changes use service-specific keys. Credentials remain in
the daemon's settings directory with restricted file permissions and are never
returned by settings or catalog endpoints.

The internal provider IDs remain `volcengine-tts` and `volcengine-seed-audio`.
Models are fixed by the official resource IDs and model names; Volcengine has no
model-list API for these services.
Existing nodes, model references, and service-specific settings endpoints stay
compatible. A saved key means configured; it does not verify service entitlement
or quota. Preview actions make a real, potentially billable generation request.

| Model                   | Produces                     | Prompt                             |
| ----------------------- | ---------------------------- | ---------------------------------- |
| TTS 2.0                 | speech                       | Spoken word for word               |
| Seed Audio 1.0          | speech, sound effects, music | Describes voices, sounds and music |
| Eleven v4, Flash v2.5   | speech                       | Spoken word for word               |
| Eleven Sound Effects v2 | sound effects                | Describes the sound                |
| Eleven Music v1         | music                        | Describes the music                |
| Scribe v2               | (transcribes)                | —                                  |

Seed Audio mixes several speakers, effects and music from one description; this
is not a structured per-speaker synthesis API. No adapter offers separate audio
stems or precise lyric singing.

Boards, drafts, copied nodes, plugin presets and generation history saved with
the older `speech`, `sound-effect`, `music` and `audio-scene` nodes or the
`generate-speech`, `generate-sound-effect` and `generate-music` tools are read
as the audio node and `generate-audio` (`src/shared/audio-legacy.ts`). Speech
text moves to the prompt; lyrics and negative prompts, which no provider took,
are dropped. Seed Audio used to add a fixed instruction per operation; it is
folded into the migrated prompt so older work sounds the same.

## Asset Canvas

The canvas creation menu has one **Audio** node. Its model picker describes
what each model makes. A text-to-speech model labels the prompt **Lines to
speak**; the others ask for a description. Text and Document nodes can supply
prompt content, and generated audio is saved in the Library. Switching models
clears the voice and any option the new model doesn't take.

Selecting one audio node that holds an asset shows **Transcribe to text** in
the media toolbar. It sends the audio to the first ready model with the
`transcribes` capability and adds the editable transcript as a Text node beside
the source. Transcription uses no media-processing slot, since it waits on the
provider rather than this machine.

**Audio settings** exposes model-supported controls: Speaker ID, style,
language, speech rate, pitch, volume, output format and sample rate. Nodes using
a TTS model additionally support eligible TTS options such as SSML,
pronunciation, language detection, dialect, trailing silence and bit rate.
Preset voices offer official samples without synthesis quota use. When the
model's provider lists voices (`listsVoices` in the catalog), the voice picker
loads them from the account instead, with search, paging and hosted samples. A
saved voice outside the loaded page stays selected by ID. Speed and language appear only
for models that speak; sound-effect and music-only models ignore them.

Audio reference uploads, trimming and image/audio references are no longer
available in audio nodes or generation requests. Existing canvas reference
fields remain readable but do not affect new generations. This change does not
remove the reference workflows for image or video generation.

Node settings survive save/reopen and copy/paste. A new audio node starts
with the last one's model and settings. Unsupported combinations are reported before requests.

A model with a length limit gets a target-duration input with preset
suggestions, including short effects, and its instrumental and loop toggles
when it offers them. Seed Audio expresses duration through natural-language
instructions; it is a target, not a guaranteed exact cut. The original generated
audio is limited to 120 seconds. A specific sub-second result needs real-service
validation or local editing.

Audio nodes expose no Audio JSON download button.

## Provider translation

The authoritative contracts are the official [Seed Audio HTTP API](https://docs.volcengine.com/docs/doubao-voice/audio-generation-http)
and [TTS HTTP API](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http).

Seed Audio uses `POST /api/v3/tts/create`, `X-Api-Key`, and `seed-audio-1.0`.
`pitch`, `volume`, and `speed` map to `audio_config.pitch_rate`,
`loudness_rate`, and `speech_rate`. A Speaker ID becomes a
`references[].speaker` entry; binary image/audio references are not accepted.
Requests enable the optional `watermark.aigc_metadata` AIGC label.
The prompt is sent as written, after a target-length, language and delivery
line when those are set. The model's user prompt limit reserves 256 characters
for that line:
2744 user characters, with a final check of the complete 3000-character request.
Linked text and delivery instructions also count toward the request limit.

TTS uses `POST /api/v3/tts/unidirectional`. Preset voices use resource
`seed-tts-2.0`; existing cloned voices use `seed-icl-2.0`, with standard or
expressive model selection. Voice instructions are not combined with cloned
voices. Creating/training a new voice is a separate workflow.
TTS pitch maps to `additions.post_process.pitch`, whereas volume and speed map
to `audio_params`. `additions` is serialized JSON. Language and dialect hints
must match an eligible voice. SSML and pronunciation correction are separate
modes; dictionary entries use `word/replacement`, one per line. SSML is limited
to Chinese and English voices; dialects to voices that list them.

Provider errors are classified by their code and message: concurrency or quota
limits return 429, missing entitlement or a resource/voice mismatch returns 503,
other `4xxxxxxx` codes return 400, and the rest return 502.

ElevenLabs follows the official [API reference](https://elevenlabs.io/docs/api-reference).
Every request sends `xi-api-key`; audio requests ask for `mp3_44100_128`, the
format every plan can use.

- Speech: `POST /v1/text-to-speech/{voice_id}` with `eleven_v4` (10,000
  characters) or `eleven_flash_v2_5` (40,000). A voice is required. Language is
  reduced to its ISO 639 primary subtag as `language_code`; speed maps
  `1 + speed / 100` onto `voice_settings.speed`, clamped to 0.7…1.2.
- Sound effects: `POST /v1/sound-generation` with `eleven_text_to_sound_v2`,
  0.5–30 seconds and an optional `loop`.
- Music: `POST /v1/music` with `music_v1`, 3–600 seconds as `music_length_ms`
  and `force_instrumental` when the node sets it.
- Voices: `GET /v2/voices` with `page_size=100`, `search` and
  `next_page_token`. Only `https` preview URLs are passed to the renderer.
- Transcription: `POST /v1/speech-to-text` as multipart form data with
  `scribe_v2`; the file stays within the daemon's audio size limit.

Error `detail` text is surfaced. 401 and 403 return 503, 429 stays 429, other
4xx return 400 and 5xx return 502. Text to Dialogue is not wired yet.

### Voice catalog

`src/shared/doubao-voices.ts` lists the TTS 2.0 preset voices with their
language, dialect and voice-instruction support, and official sample URL. It is
generated by `scripts/sync-doubao-voices.ts` from the OpenAPI `ListSpeakers`
action, which needs a Volcengine AccessKey rather than the speech API key:

```bash
VOLCENGINE_ACCESS_KEY_ID=... VOLCENGINE_SECRET_ACCESS_KEY=... bun run voices:doubao
```

The script keeps existing order and capability flags, refreshes names and
sample URLs, and appends new voices. Dialect and instruction support are not
returned by the API and follow the published voice list.

Pitch is an integer from -12 to 12. Speech rate and volume are integers from -50
to 100 in provider-relative units; volume is not dB. Zero preserves the default.

| Output   | Seed sample rates (Hz)                         | TTS sample rates (Hz)                          |
| -------- | ---------------------------------------------- | ---------------------------------------------- |
| MP3      | 8000, 16000, 24000, 32000, 44100, 48000        | 8000, 16000, 22050, 24000, 32000, 44100, 48000 |
| WAV      | 8000, 16000, 24000, 32000, 40000, 44100, 48000 | Not exposed for the streaming adapter          |
| Ogg Opus | 48000                                          | 48000                                          |

The application deliberately does not concatenate streaming WAV output. TTS
MP3/Opus bit rates can be selected; Seed does not advertise that parameter.
Output bytes are strictly Base64-decoded and demuxed to check the actual audio
format, sample rate, channel count, and playable sample duration. Provider
responses are bounded; generation times out after five minutes, supports local
cancellation, and is not automatically resubmitted on failure.

## Metadata and project files

Generated assets retain actual duration, original billable duration when
returned, sample rate, codec, provider request ID and reported character usage.
Project materialization and Agent tools retain `.audio.json` metadata companions.
Subtitle generation, timestamp parsing, playback transcripts and SRT/WebVTT
exports are removed. Legacy assets remain readable; old subtitle metadata is
ignored and omitted from new companion files.

## HTTP interfaces

- `GET /audio-models/catalog` — live models, capabilities and provider states;
- service-specific GET/PUT endpoints at
  `/settings/models/providers/volcengine-tts` (key and `defaultVoiceId`) and
  `/settings/models/providers/volcengine-seed-audio`;
- `DELETE /settings/models/providers/<provider-id>` — disconnect one service;
- `POST /settings/models/providers/volcengine-tts/preview` — a short speech test;
- `POST /settings/models/providers/volcengine-seed-audio/preview` — a short effect test;
- GET/PUT `/settings/models/providers/elevenlabs` (key) and
  `DELETE /settings/models/providers/elevenlabs/credential`;
- `GET /audio-providers/<provider-id>/voices?search=&pageToken=` — one page of
  account voices; 404 when the provider has no voice list, 503 when it is not
  ready;
- `POST /projects/<id>/canvas/media` with `operation: "transcribe-audio"` —
  returns `{ kind: "text", text }`;
- `POST /tools/<tool-id>/jobs` — enqueue one of the tools above.

The unified `/settings/models/providers/doubao-voice` endpoints and Library audio
companion download endpoint are removed. New audio requests reject `references`,
`referenceAssetId` and `subtitles`; existing saved canvas fields are omitted
when constructing a new request.

## Capability validation

The catalog and adapters check the selected model and available provider,
text limits (including linked text and generated instructions), target duration,
format-specific sample rates, channels and bit rate. Looping fails before a
Seed request. TTS-specific
options cannot be sent to Seed. Voice checks cover Speaker ID syntax, eligible
preset dialects, voice instructions, cloned-voice model selection, SSML language
limits and the conflict between SSML and a pronunciation dictionary. Numeric
controls must be integers in the advertised range. Returned bytes are decoded
and inspected as playable audio. These checks do not verify entitlement, quota
or generated content quality; those still require provider calls.

## Adding another provider

Extend `AudioProviderAdapter`, publish precise model capabilities, and translate
only supported settings. Implement `voices` when the account owns its voice
list and `transcribe` when a model declares `transcribes`; the canvas picks
both up from the catalog without provider-specific UI. Keep protocol details inside the adapter and normalized
metadata storage inside the common pipeline. Extend existing provider,
job, canvas, settings, and export tests before adding another boundary. Real
credentials are still needed to validate entitlement, voice consistency,
and production latency.
