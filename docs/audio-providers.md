# Audio providers

Audio is a capability family: speech, sound effects, music, and composite scene
creation share model selection, jobs, Library storage, and project export. The
daemon owns credentials and provider calls. Canvas and agents submit the same
provider-neutral text and output settings.

## Providers and connection settings

**Settings → Providers & Models** lists **Doubao Speech** and **Doubao Seed Audio**
as separate providers. Each has its own API key, enable state, preview, model
list and deletion action. Speech also has a default voice setting. Saving or
removing one service does not change the other.

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

| Tool                    | Operation      | Models                                  |
| ----------------------- | -------------- | --------------------------------------- |
| `generate-speech`       | `speech`       | TTS 2.0; Seed Audio 1.0                 |
| `generate-sound-effect` | `sound-effect` | Seed Audio 1.0                          |
| `generate-music`        | `music`        | Seed Audio 1.0, instrumental workflow   |
| `generate-audio`        | `audio-scene`  | Seed Audio 1.0, composite scene prompts |

`dialogue` remains a reserved shared operation. Use an audio-scene prompt to
express multiple speakers; this is not a structured per-speaker synthesis API.
No adapter currently advertises seamless looping, separate audio stems, negative
prompts, or precise lyric singing. Unsupported controls fail before generation.

## Asset Canvas

The canvas creation menu offers **Sound effect** and **Music**. The home-page
audio shortcut opens a Music node. Speech and Audio creation are no longer
creation-menu entries; existing nodes remain readable and playable. Their
text-only generation paths and Agent tools remain available for compatibility.
Text and Document nodes can still supply prompt content.

**Audio settings** exposes model-supported controls: Speaker ID, style,
language, speech rate, pitch, volume, output format and sample rate. Existing
speech nodes additionally support eligible TTS options such as SSML,
pronunciation, language detection, dialect, trailing silence and bit rate.
Preset voices offer official samples without synthesis quota use.

Music and Audio creation nodes show no **Audio settings**: they keep the
prompt, model, target duration and the model's instrumental and loop toggles.
Audio settings saved on these nodes are neither remembered for new nodes nor
sent with new generations, so the provider's defaults apply.

Audio reference uploads, trimming and image/audio references are no longer
available in audio nodes or generation requests. Existing canvas reference
fields remain readable but do not affect new generations. This change does not
remove the reference workflows for image or video generation.

Node settings survive save/reopen and copy/paste. Output preferences are
remembered per node type. Unsupported combinations are reported before requests.

Sound effects and music provide a target-duration input with preset suggestions,
including short effects. Seed Audio expresses duration through natural-language
instructions; it is a target, not a guaranteed exact cut. The original generated
audio is limited to 120 seconds. A specific sub-second result needs real-service
validation or local editing.

Music remains an instrumental workflow. Neither music nor sound effects exposes
an Audio JSON download button.

## Provider translation

The authoritative contracts are the official [Seed Audio HTTP API](https://docs.volcengine.com/docs/doubao-voice/audio-generation-http)
and [TTS HTTP API](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http).

Seed Audio uses `POST /api/v3/tts/create`, `X-Api-Key`, and `seed-audio-1.0`.
`pitch`, `volume`, and `speed` map to `audio_config.pitch_rate`,
`loudness_rate`, and `speech_rate`. A Speaker ID becomes a
`references[].speaker` entry; binary image/audio references are not accepted.
Requests enable the optional `watermark.aigc_metadata` AIGC label.
The model's user prompt limit reserves 256 characters for generated instructions:
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
- `POST /tools/<tool-id>/jobs` — enqueue one of the tools above.

The unified `/settings/models/providers/doubao-voice` endpoints and Library audio
companion download endpoint are removed. New audio requests reject `references`,
`referenceAssetId` and `subtitles`; existing saved canvas fields are omitted
when constructing a new request.

## Capability validation

The catalog and adapters check the selected operation and available provider,
text limits (including linked text and generated instructions), target duration,
format-specific sample rates, channels and bit rate. Unsupported looping,
negative prompts, lyrics and vocal music fail before a Seed request. TTS-specific
options cannot be sent to Seed. Voice checks cover Speaker ID syntax, eligible
preset dialects, voice instructions, cloned-voice model selection, SSML language
limits and the conflict between SSML and a pronunciation dictionary. Numeric
controls must be integers in the advertised range. Returned bytes are decoded
and inspected as playable audio. These checks do not verify entitlement, quota
or generated content quality; those still require provider calls.

## Adding another provider

Extend `AudioProviderAdapter`, publish precise model capabilities, and translate
only supported settings. Keep protocol details inside the adapter and normalized
metadata storage inside the common pipeline. Extend existing provider,
job, canvas, settings, and export tests before adding another boundary. Real
credentials are still needed to validate entitlement, voice consistency,
and production latency.
