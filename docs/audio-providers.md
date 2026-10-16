# Audio providers

OhMyGame treats audio as a capability family rather than a TTS-only feature. The shared contract has four operations:

- `speech` for narration and character voices;
- `dialogue` for multi-speaker synthesis when a provider supports it;
- `sound-effect` for prompted effects and ambience;
- `music` for instrumental or lyrical music.

The daemon owns credentials, provider calls, generated files, and Library registration. The renderer and agents submit provider-neutral requests and never receive saved API keys.

## Architecture

`src/shared/audio.ts` defines requests, output settings, model capabilities, catalogs, and generated-audio metadata. A provider adapter implements `AudioProviderAdapter`; `ProviderAudio` selects only a configured, enabled model that advertises the requested operation. `ToolRunner` then persists MP3 or WAV output through the same job and Library flow used by image, video, and 3D generation.

The stable tool boundary is:

| Tool                    | Operation      | Current implementation                     |
| ----------------------- | -------------- | ------------------------------------------ |
| `generate-speech`       | `speech`       | Volcengine Doubao Speech synthesis 2.0     |
| `generate-sound-effect` | `sound-effect` | Contract ready; needs a compatible adapter |
| `generate-music`        | `music`        | Contract ready; needs a compatible adapter |

Unsupported operations fail before an incompatible provider is called. Adding ElevenLabs, MiniMax, Suno, Gemini, Fish Audio, or SiliconFlow should normally require a new adapter and settings integration, not changes to jobs or Library storage.

## Asset Canvas audio nodes

Asset Canvas exposes the common layer as three generation node types: **Speech**, **Sound effect**, and **Music**. The Add menu shows a type only when the live audio catalog contains a configured, enabled model for that operation, and each existing node filters the same catalog by its required operation. A speech-only model therefore cannot be selected for music or effects. A Text or Document node can be connected as a prompt source; its current content is combined with the node's local text when the job starts.

Speech nodes store provider-neutral model, speaker, and speed settings. Sound-effect and music nodes store provider-neutral prompt, duration, and loop settings, plus capability-gated options such as negative prompts, lyrics, and instrumental mode. Generated MP3 or WAV output is registered in the Library, written back to the node as an `assetId`, and playable in both generation nodes and Library asset nodes. Model and option selections are remembered independently for each node type.

Existing nodes remain readable when a provider is disconnected, but generation stays disabled until a compatible model is available. Installing a future adapter that advertises sound-effect or music activates the existing node contract and adds that node type to the menu without another canvas schema change. Agent generation tools follow the same live capability filter, so unsupported operations are not offered on a turn.

## Volcengine Doubao Speech

The first adapter uses the official TTS v3 unidirectional HTTP streaming endpoint. Configure it in **Settings → Providers & Models → Doubao Speech**. The key is stored in the local data directory with restricted file permissions and is sent only from the daemon.

Configure a default Volcengine Speaker ID from the console's Voice Library, or supply `voiceId` on an individual request. The adapter supports the official Speech synthesis 2.0 service, MP3 output, mono audio, supported sample rates, language hints, delivery context, and speech-rate control. The first adapter deliberately avoids streamed WAV because the provider documents repeated WAV headers as a streaming caveat; the common layer still supports WAV for adapters that return a valid complete file. Account activation, API key access, model entitlement, quota, and the exact voice ID still belong to the user's Volcengine account and must be verified with a real credential. Voice Clone 2.0 (`seed-icl-2.0`) is intentionally separate because its resource ID, entitlements, and model options differ.

The settings page ships the published seed-tts-2.0 preset voice catalog (`VOLCENGINE_TTS_VOICES` in `src/shared/audio.ts`) as a picker. The provider's `ListSpeakers` API is a console API that requires AccessKey signing instead of the console API key, so the catalog is bundled from the official voice list; cloned or custom Speaker IDs can still be entered as raw IDs. The default voice saves on its own without re-entering the API key, and a preview action synthesizes a short sample (up to 500 characters) to verify the connection and voice before real use.

The daemon endpoints are:

- `GET /audio-models/catalog` — available models plus provider status;
- `GET /settings/models/providers/volcengine-tts` — saved settings without the key;
- `PUT /settings/models/providers/volcengine-tts` — save `{ "apiKey": "..." }`, `{ "defaultVoiceId": "..." }`, or both (voice-only updates keep the stored key; `defaultVoiceId: null` clears it);
- `POST /settings/models/providers/volcengine-tts/preview` — synthesize a short sample and return MP3 bytes;
- `DELETE /settings/models/providers/volcengine-tts` — remove the saved connection;
- `POST /tools/generate-speech/jobs` — enqueue speech generation.

Example job body:

```json
{
  "text": "欢迎来到雾港。",
  "voiceId": "your-volcengine-voice-id",
  "style": "calm fantasy narrator",
  "speed": 0,
  "output": { "format": "mp3", "sampleRate": 24000 }
}
```

The model can be omitted to use the first configured compatible model, or supplied explicitly as `{ "provider": "volcengine-tts", "id": "seed-tts-2.0" }`.

## Adding another provider

1. Describe every offered model with precise operations, formats, duration/text limits, execution mode, and optional features.
2. Implement an adapter that translates only supported fields and maps authentication, quota, validation, provider, and network failures to `AudioGenerationError`.
3. Keep task polling or streaming details inside the adapter. Return final bytes plus normalized metadata.
4. Add a secret settings store and provider UI. Never expose the secret from a read endpoint.
5. Add request-translation, failure-mapping, catalog, job, and Library tests.

Do not make one adapter pretend to support all audio operations. Capability-driven selection is what lets TTS, effects, music, dialogue, voice cloning, and future realtime speech coexist behind one contract.
