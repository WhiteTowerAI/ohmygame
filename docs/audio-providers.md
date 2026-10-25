# Audio providers

Audio is a capability family: speech, sound effects, music, and composite scene
creation share model selection, jobs, Library storage, and project export. The
daemon owns credentials and provider calls. Canvas and agents submit the same
provider-neutral settings and asset references.

## Providers and connection settings

**Settings → Providers & Models → Doubao Voice** connects both services with one
API key. The Speech synthesis and Audio generation tabs retain separate enable
switches, tests, and optional credential overrides. Existing independent keys
are preserved when they differ. Saving a shared key explicitly replaces both
service selections; disconnecting one service keeps the other connected.
Credentials are stored locally with restricted file permissions and never
returned by settings or catalog endpoints.

The internal provider IDs remain `volcengine-tts` and `volcengine-seed-audio`.
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

Speech, Sound effect, Music, and Audio creation appear when a configured,
enabled model supports the operation. Existing nodes remain readable after a
service is disconnected. Text and Document nodes can supply prompt content.

**Voice, references and output** exposes model-supported controls:

- preset or custom Speaker ID, including an existing cloned voice;
- delivery style, language, and speech rate;
- pitch, volume, subtitles, format, and sample rate;
- TTS automatic language recognition, dialect, pronunciation dictionary, SSML,
  trailing silence, and bit rate;
- ordered reference media from uploads, the Library, or connected image/audio
  generation nodes that already have an output.

Node settings survive save/reopen and copy/paste. Voice and output preferences
are remembered per node type; source references remain local to their node.
Switching models retains reference drafts and reports incompatible inputs.

Sound effects and music provide target-duration presets and manual input,
including short effects. Seed Audio expresses duration through natural-language
instructions; it is a target, not a guaranteed exact cut. The original generated
audio is limited to 120 seconds. A specific sub-second result needs real-service
validation or local editing.

Audio creation preserves general prompts combining dialogue, ambience, effects,
and music; it does not append the dedicated tools' no-voice instructions.
Music remains an instrumental workflow. Reference images are supported with
text; their suitability for a particular pure-ambience task must be evaluated
with real examples.

## Reference media

Seed Audio supports these separate input modes:

| Mode  | Limits                                                                       |
| ----- | ---------------------------------------------------------------------------- |
| Audio | Up to 3 references; each at most 30 seconds and 10 MB; WAV, MP3, or Ogg Opus |
| Image | One PNG, JPEG, or WebP at most 10 MB                                         |
| Voice | A preset TTS 2.0 Speaker ID or an existing cloned Speaker ID                 |

Images cannot be combined with audio references or a Speaker ID. The application
also keeps audio-reference and Speaker-ID modes separate until their mixed
numbering has been validated against real responses. It does not infer a
three-speaker limit from the three-uploaded-audio limit.

Each canvas reference has a stable `AudioN`/`ImageN` alias and a node or Library
source. Prompts use `@AudioN`; the daemon maps aliases to the actual ordered
`@音频N` references required by Seed Audio. Reordering does not change their
meaning, and a removed alias cannot silently point to a replacement asset.

Audio uploads can be decoded locally and a selected range saved as a new PCM
WAV reference. The original and clip provenance are retained. The daemon checks
actual encoded format, duration, and size instead of trusting uploaded metadata.
M4A and other browser-decodable sources need conversion before reference use;
plain Ogg does not necessarily contain Opus. Raw PCM is not exposed because it
needs external decoding parameters. Reference binary data is read by the daemon
and sent as Base64; canvas files and task history contain asset IDs, not Base64
or expiring URLs. Submitted tasks resolve node references to fixed assets.

## Provider translation

The authoritative contracts are the official [Seed Audio HTTP API](https://docs.volcengine.com/docs/DoubaoVoice/audio-generation-http?lang=zh)
and [TTS HTTP API](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh).

Seed Audio uses `POST /api/v3/tts/create`, `X-Api-Key`, and `seed-audio-1.0`.
`pitch`, `volume`, `speed`, and `subtitles` map to `audio_config.pitch_rate`,
`loudness_rate`, `speech_rate`, and `enable_subtitle`. A Speaker ID becomes a
`references[].speaker` entry. Reference images/audio become Base64 entries.
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
modes; dictionary entries use `word/replacement`, one per line.

Pitch is an integer from -12 to 12. Speech rate and volume are integers from -50
to 100 in provider-relative units; volume is not dB. Zero preserves the default.
TTS subtitles support Chinese and English; Seed subtitle language availability
must be verified for the selected content.

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

## Subtitles, metadata, and project files

Subtitles normalize to sentence/word entries with `startMs` and `endMs`.
Seed timestamps are milliseconds; TTS word timestamps are converted from seconds.
The canvas shows the active sentence during playback. Audio assets retain
subtitle JSON and metadata in the Library and canvas manifest, including
provider request ID, actual duration, original billable duration when returned,
sample rate, codec, and reported character usage.

Library/canvas previews offer Audio JSON, SRT, and WebVTT downloads. Materializing
an asset in a game project writes companions beside the audio:

- `voice.mp3.audio.json` — normalized subtitles, metadata, and generation input;
- `voice.mp3.srt` and `voice.mp3.vtt` — sentence-level subtitles, when available.

Agent tools return all written paths. Word timing remains in JSON for game UI
and timing logic; it does not imply an implemented lip-sync/viseme system.
Companions persist after temporary tool runs are removed and travel with the
project's files. Asset Canvas dependencies include reference audio and images.
A generation with no spoken text can validly return no subtitles.

## HTTP interfaces

- `GET /audio-models/catalog` — live models, capabilities, and provider states;
- `GET /settings/models/providers/doubao-voice` — shared connection state, no key;
- `PUT /settings/models/providers/doubao-voice` — set `{ "apiKey": "..." }` for both services;
- service-specific GET/PUT/DELETE endpoints remain available at
  `/settings/models/providers/volcengine-tts` and `volcengine-seed-audio`;
- `POST /settings/models/providers/volcengine-tts/preview` — a short speech test;
- `POST /settings/models/providers/volcengine-seed-audio/preview` — a short effect test;
- `POST /tools/<tool-id>/jobs` — enqueue one of the tools above;
- `GET /library/assets/<asset-id>/audio/audio.audio.json`, `audio.srt`, or
  `audio.vtt` — persistent audio companions when available.

Example scene request (references use existing Library asset IDs):

```json
{
  "prompt": "A character says Welcome over the rain in @Audio1, followed by quiet footsteps.",
  "model": { "provider": "volcengine-seed-audio", "id": "seed-audio-1.0" },
  "references": [
    { "id": "Audio1", "type": "audio", "assetId": "library-asset-id" }
  ],
  "pitch": -2,
  "volume": 10,
  "subtitles": true,
  "durationSeconds": 8,
  "output": { "format": "wav", "sampleRate": 48000 }
}
```

## Adding another provider

Extend `AudioProviderAdapter`, publish precise model capabilities, and translate
only supported settings. Keep protocol details inside the adapter and normalized
subtitle/metadata storage inside the common pipeline. Extend existing provider,
job, canvas, settings, and export tests before adding another boundary. Real
credentials are still needed to validate entitlement, voice consistency,
reference-image results, subtitle chunk timing, and production latency.
