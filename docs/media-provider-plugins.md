# Media provider plugins

Plugin API 2.5 introduced this contract; API 2.9 adds durable paid steps and
2.10 adds host-owned input files; 2.11 adds 3D retexture and remesh;
2.12 adds animation and its action library. Built: the sandbox, `host.fetch`, images, videos, audio
and 3D models (`src/daemon/plugin-media-sandbox.ts`,
`src/daemon/plugin-media-providers.ts`, wired into `ProviderImages`,
`ProviderVideos`, `ProviderAudio` and `ProviderModels3D`), video and 3D tasks
a retry resumes after a restart (`src/daemon/media-task-journal.ts`), and the
market's kinds. What is left is in [Order of work](#order-of-work).

A plugin's model provider can make images, videos, audio and 3D models, not
only chat. The
vendor's API, which differs from vendor to vendor and changes often, is the
plugin's to translate, so a change there ships as a plugin update, not an
OhMyGame release. OhMyGame changes only when it wants something new from
every provider, such as a first and last frame for video.

## Background removal (API 2.27)

An image provider may declare `media.image.backgroundRemoval` with a distinct
`id` and optional `title`, `description` and bounded `data`, alongside its image
models. This is a processing model, excluded from generation discovery, visibility
settings and defaults. The image catalog exposes it in `backgroundRemovalModels`
only while its plugin, provider, grants and key are available. The agent can read
these choices with `list_background_removal_models`.

`image.start` receives `{ operation: "remove-background", model, image,
modelData? }`. `image` is a host-owned PNG file handle; send it with
`{ $mediaFile: input.image.file }` in `host.fetch` JSON. The host validates one
still PNG/JPEG/WebP source up to 20 MiB and 64 million pixels, applies EXIF
orientation, converts it to sRGB and normalizes to PNG outside the sandbox.
There is no prompt, requested resolution or aspect ratio. The existing
`image.start` generation contract stays unchanged for other calls.

Return an ordinary queued task or image output. The output must be a PNG with
alpha and exactly the normalized source dimensions. The host uses only its alpha,
multiplies it by the source alpha and keeps the source RGB pixels. Empty or fully
opaque masks, resized outputs and malformed images fail without a replacement
paid request. Use an asynchronous queue that retains results. On local stop,
adapters should keep a resumable remote task rather than cancel it.

Canvas **Image tools → Remove background** creates an image node with
`backgroundRemoval: true`, an empty prompt and one reference. Choose its processing
model and generate explicitly. It uses the existing shared canvas history and
recovery ID; `remove_image_background` offers the same processing for direct agent
calls. Canvas jobs snapshot source bytes and keep them for retry. Small task
receipts remain under `tools/media-tasks` after output storage, until profile
removal, because later canvas import or job persistence can fail. Retrying the
same job resumes that receipt; a new direct agent call is a new task and must
not replace an uncertain submission. No generation defaults are changed.

Existing image nodes retain their behavior; existing AI image cutout remains a
prompted redraw. Older canvas readers reject the new field instead of silently
turning processing into generation. No compatibility migration is needed because
absence of the field still means generation.

## Recoverable image generation (API 2.29)

An image provider can opt in with `media.image.recoverable: true`. Its ordinary
`image.start` input stays the same, and `host.submit` becomes available for a
retained submission receipt. Require API `^2.29.0`; older hosts must not load this
contract. Providers without the flag, including native image generators, retain
their existing behavior.

A recoverable image job produces one image. The catalog already offers one output
for plugin image models; direct multi-output requests are rejected before any
submission. `maxMinutes` may be set alongside `recoverable` to bound the entire
wait and download from 1 to 120 minutes; the default remains ten minutes.
Return a queued task or an ordinary image output. Use `host.submit` for the paid
step. The host retains receipts through output storage and later canvas import
failures, until profile removal. Local stop, timeout and app shutdown preserve
remote ownership; the host does not call the adapter's `cancel` for this operation.

Canvas and tool-job retries carry their original recovery ID and an internal
`resuming: true` flag, hidden from public job views. A retry may only use an
existing receipt. An old non-recoverable task, a missing receipt, or an attempt
that failed before recording a task cannot be silently reinterpreted as new paid
work after a plugin upgrade. Check the provider and explicitly start a new
generation if no receipt exists. Changed input/account or an unconfirmed response
also refuses a replacement submission. If a saved receipt exists and the provider
loses recovery support or is replaced by a native adapter, retry refuses to fall
back to a new generation; restore the original provider. Legacy image jobs with
no receipt retain their existing behavior when the provider has not opted in.
Stored inputs and source references remain unchanged on retry. A new direct agent call, or generating a failed canvas node
again, starts new work; use the original saved job’s Retry action for recovery.
Loading an unsupported retry flag refuses the file rather than rewriting it; missing flags need no migration because the Retry action sets it.

### Saved image workflows

API 2.31 adds `media.image.configuration: ["workflow", "promptNode"]` alongside
`recoverable: true`. It names up to 16 distinct declared `text`, `select`,
`boolean` or `json` settings; paths and secrets cannot be bound. The host passes
only these values in `image.start`'s `input.configuration`, parsing JSON settings
into objects. Required missing values and a combined snapshot larger than
256 KiB are rejected before adapter execution. A JSON field supports import and
editing in plugin Settings; use a separate secret field for any credentials.

Before the adapter starts, the host pins the snapshot in the job's existing
version-1 journal. It uses a reserved reference receipt, scoped to the plugin
package, so a staged retry reuses the original configuration even after settings
are changed or cleared. A recorded task or result resumes without reading current
configuration. The adapter must include any fields needed by `check` in its
bounded task. Binding changes refuse replay; changed packages refuse staged
replay, as with saved submissions. No journal-format migration is needed.

An invalid initial configuration leaves no receipt. Once a snapshot is saved,
Retry retains it even if adapter validation fails; fix settings and explicitly
start a new generation to use them. Never put a workflow in the task's small
payload or infer permission to resubmit from missing remote history.

Image models can declare `supportsResolution: false` and/or
`supportsAspectRatio: false`, with an empty `resolutions` and/or `aspectRatios`
array respectively. The workflow owns those dimensions: the host hides their
controls, ignores retained canvas choices for them, and omits them from adapter
input. Other dimensions keep their ordinary choices and validation. When both dimensions belong to the workflow, the catalog has no dimension
choices and model selection preserves the saved canvas preferences. A placeholder
for a single disabled dimension serves internal layout only, not a claim about
the generated size. Preserve the workflow's actual dimensions and validate the
returned image. This API adds no models or local server installation itself.

## What stays the same

- A provider is one entry in `contributes.providers`, one row in Settings →
  Providers and on the plugin's page, with one key. A vendor that serves chat,
  images and video is one provider, not three.
- Its key is a `secret` setting the app reads. The plugin's code never sees it;
  the app adds it to the requests the adapter marks, which can only go to the
  hosts the person approved.
- The hosts it reaches are its `capabilities.network`, which the person
  approves when adding it. A media provider asks for nothing more.

## The manifest

```json
{
  "capabilities": { "network": ["api.siliconflow.cn", "sc-maas.oss-cn-shanghai.aliyuncs.com"] },
  "contributes": {
    "providers": [{
      "id": "siliconflow",
      "title": "%provider%",
      "icon": "./assets/icon.svg",
      "apiKey": "apiKey",
      "api": "openai-completions",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "discoverModels": true,
      "media": {
        "adapter": "./media.js",
        "auth": { "header": "authorization", "scheme": "Bearer" },
        "image": { "models": [{ "id": "Kwai-Kolors/Kolors", "title": "Kolors",
          "resolutions": ["1K"], "aspectRatios": ["1:1", "16:9", "9:16"], "maxReferenceImages": 1 }] },
        "video": { "maxMinutes": 30, "models": [{ "id": "MiniMaxAI/MiniMax-H3", "title": "MiniMax-H3",
          "durations": [5, 10, 15], "resolutions": ["768p", "480p"], "aspectRatios": ["16:9", "9:16"],
          "maxReferenceImages": 2, "referenceModes": ["frame"] }] }
      }
    }]
  }
}
```

- `api` and `baseUrl` become optional, so a provider can make media only.
  It needs at least one of chat (`api`, `baseUrl`) and `media`.
- `media.adapter` is a JavaScript file in the package (at most 512 KB), one
  module with no `import`s: bundle anything it needs into it.
- `media.auth` says how the app adds the key to a request the adapter marks
  `auth: true`. It can be a header with an optional scheme (`Bearer`), or a
  query parameter. Signing a request with the key, as Volcengine's API does,
  is left for later; such vendors stay built in until then.
- Each kind lists its models and what they take. These are the fields the app
  already uses for its own image, video, audio and 3D models, so pickers, the
  canvas and the agent's tools work unchanged.
- **Audio** models (`media.audio.models`) say the `kinds` they make
  (`speech`, `sound-effect`, `music`), whether they speak the prompt word for
  word (`readsText`) and in which `voices`, the `formats` they can be asked
  for (`mp3`, `wav`, `ogg_opus`; `mp3` when left out), and the limits they take:
  `maxTextCharacters`, `minDurationSeconds`, `maxDurationSeconds`,
  `instrumental` and `loop`.
  API 2.17 adds `languages`, `speedRange: [min, max]` on the shared -50…100
  scale for models that `readsText`, and `sampleRatesByFormat` (for example
  `{ "mp3": [44100] }`). Each rate must be one of the app's supported rates
  and each format must be declared. `maxTextCharacters` may reach 40,000;
  duration limits may be fractional from 0.1 to 600 seconds. Existing
  declarations retain their defaults. Plugins using these additions need
  `engines.ohmygame-api: "^2.17.0"`. Account voice discovery is described below; transcription
  remains a separate migration obligation.
  API 2.22 adds opt-in booleans `speaker`, `pitch`, `volume`, `style`,
  `ssml` and `speechOptions`. They expose the existing shared audio controls
  and pass the selected fields to `audio.start`. `speaker` accepts custom IDs
  (including cloned or reference speakers), even for prompt-directed audio;
  account-voice providers still require a chosen account voice. Static voice
  lists remain restrictive unless `speaker` is declared. `ssml` and
  `speechOptions` require `readsText`. Speech options pass `voiceKind`,
  `voiceModel`, `autoLanguage`, `dialect`, `pronunciation`, `silenceMs`,
  `sectionId` and the output's `bitRate` as top-level adapter input fields.
  Their bounds are the shared audio request schema; the adapter validates
  vendor-specific combinations. Undeclared options stay saved but are not
  sent. With API 2.22 any generation model may declare `speedRange`, which
  also passes speed for non-speech kinds. Existing declarations keep their
  previous behavior. These additions require `engines.ohmygame-api: "^2.22.0"`.
  API 2.24 adds `media.audio.defaultVoiceSetting`, naming a `text` or `select`
  configuration field. Its current value (or configuration default) appears in
  the provider catalog and supplies a missing voice for `readsText` models.
  Explicit request voices win; prompt-directed audio never inherits this speech
  default as a reference speaker. Clearing the setting restores its declared
  default. Invalid saved IDs stay visible but generation rejects them before
  HTTP rather than silently choosing another voice. Secret, path and boolean
  fields cannot supply voices. Account voice discovery still requires explicit
  selection and cannot be combined with this setting. Require
  `engines.ohmygame-api: "^2.24.0"` for this binding.
  API 2.32 adds `media.audio.configuration`, an array of 1–16 distinct names of
  declared non-secret `text`, `select`, `boolean` or `json` settings. A generation
  needs a durable job: before `audio.start`, the host pins their values as
  `input.configuration`, with JSON strings parsed into objects. Missing required
  values or a combined snapshot over 256 KiB fail before any adapter request.
  Voice discovery, model discovery and transcription do not receive these values.
  A staged retry reuses the saved snapshot and submit responses even if settings
  were changed or cleared. Binding names and package scope protect replay; existing
  task/result receipts resume without re-reading configuration. This shares the
  [image settings lifecycle](#saved-image-workflows), preserving its existing receipt
  keys and journal format. Ordinary model/options/account identity rules remain;
  the binding does not pin a remote server's model weights or reference file bytes.
  Adapters must retain any settings needed by `check` in their task. A missing
  synchronous response remains uncertain, not a recoverable remote task. Existing
  plugins without the binding keep their behavior. Require
  `engines.ohmygame-api: "^2.32.0"` when declaring it.
  With API 2.18, `media.audio.listVoices: true` uses the adapter's
  `audio.voices({ search?, pageToken? }, host)` instead of the static list.
  It returns `{ voices: [{ id, name, previewUrl?, labels? }], nextPageToken? }`.
  Search is at most 200 characters and page tokens at most 2,000. Each page
  has at most 500 distinct voices, allowing default voices returned in addition
  to an account's requested page size; IDs follow the app's voice ID rules
  (letters, digits, `_`, `-`, at most 256 characters), names are at most 200
  characters, and labels have at most 20 entries (80-character keys and
  200-character values). Omit the next token on the last page; returning
  the requested token is invalid. Previews must be HTTPS URLs on an approved
  network host, without URL credentials and at most 2,048 characters.
  Queries have a 30-second deadline and allow only `GET`/`HEAD`; uploads,
  submissions and shared paid steps are unavailable. No queries run just
  to build the model catalog. Text-reading models require an explicit voice;
  the first static or returned voice is never chosen automatically. Saved
  IDs outside the current page remain valid selections. Declare
  `engines.ohmygame-api: "^2.18.0"`. Existing static voice lists keep their
  defaults when `listVoices` is absent.
- **3D** models (`media["3d"].models`) say the `operations` they make from
  (`text`, a prompt; `image`, pictures of the object), how many pictures they
  take (`maxReferenceImages`, 1 when left out), their `polycount` range and
  default, with the `presets` the canvas offers, and whether they `texture`
  the model and make `pbr` materials. API 2.11 also accepts `defaults: { texture,
  pbr }` (both must be supported), `estimatedCredits`, and ordered
  `referenceImageLabels` (up to eight). API 2.16 keeps labels beyond the active
  reference limit, so reducing and later raising a custom version’s limit does
  not lose its view names.
- `audio` and `3d` take `maxMinutes` as `video` does (10 and 15 minutes when
  left out).
- Any model may have a `description` and `data`: the adapter's own JSON, at
  most 4 KB, given back with each request as `input.modelData`, such as which
  of the vendor's fields the model takes.
- A kind with `"discoverModels": true` can list more of the vendor's models
  (see [Listing the vendor's models](#listing-the-vendors-models)). The models
  the manifest lists are then the ones that are on by default.
- The kinds a provider declares are what the market lists it under (see
  [Market](#market)). Chat counts when `api` is set.

## The adapter

The adapter is a script with no access to files, processes, timers or the
network. Its only way out is the `host` object the app passes in. It exports
one object with a section per kind:

```js
export default {
  image: {
    async start(input, host) {
      const response = await host.fetch("https://api.siliconflow.cn/v1/images/generations", {
        method: "POST", auth: true,
        json: { model: input.model, prompt: input.prompt, image_size: size(input.aspectRatio) },
      });
      if (!response.ok) return { error: (await response.json()).message };
      return { outputs: (await response.json()).images.map((image) => ({ url: image.url })) };
    },
  },
  video: {
    async start(input, host) {
      const response = await host.fetch(".../video/submit", { method: "POST", auth: true, json: { /* … */ } });
      return { task: { id: (await response.json()).requestId } };
    },
    async check(task, host) {
      const status = await (await host.fetch(".../video/status", { method: "POST", auth: true, json: { requestId: task.id } })).json();
      if (status.status === "Succeed") return { outputs: [{ url: status.results.videos[0].url }] };
      if (status.status === "Failed") return { error: status.reason };
      return { progress: status.progress, retryAfter: 5 };
    },
    async cancel(task, host) { /* optional */ },
  },
};
```

Every kind has the same three steps, so a vendor that answers at once and one
that takes minutes are written the same way:

- **`start(input, host)`** returns one of:
  - `{ outputs }`: the result now;
  - `{ task }`: a small JSON value to check later, at most 16 KB;
  - `{ error }`: a message the person sees.
- **`check(task, host)`** returns `{ outputs }`, `{ error }`, or `{ progress?,
  retryAfter? }` while the work goes on. It is needed only when `start` can
  return a task.
- **`cancel(task, host)`** is optional. It is called, with 30 seconds to
  finish, when the person or the agent stops the work or it runs out of time
  (10 minutes by default for an image) while the vendor holds a task.
  Recoverable images preserve the remote task and skip this call on local stop,
  timeout and shutdown.

`input` is what OhMyGame asks for. It is fixed per kind and versioned with the
plugin API. Every kind's input also has `modelData` when the model has
`data`. A JavaScript section is named as the kind, so 3D is
`export default { "3d": { start, check } }`.

- **Image:** `model`, `prompt`, `resolution` and `aspectRatio` (one of the
  model's, after a legacy size is matched to them), `transparentBackground`
  when the asset needs one, and `references` (`[{ mediaType, base64 }]`).
  API 2.30 adds two image model fields. `minReferenceImages` (0–16, at most
  `maxReferenceImages`) is how many pictures a request needs: the canvas
  waits for them and the app refuses a request with fewer.
  `maxReferenceImageDimension` (16–4096) is the longest side a picture
  reaches the adapter with; the app scales larger ones down to a PNG with
  nearest-neighbour sampling, so pixel art keeps hard edges, and leaves the
  canvas copy as it was. A GIF on the canvas, such as an animated result,
  is sent on as a reference by its first frame, as a PNG. API 2.33 adds
  `promptOptionalWithReference`: when true, the Image node may run without
  text after a reference image is connected. The adapter must define how it
  interprets an empty `prompt`; it still receives an empty string. API 2.34
  adds `animationFrames`: when true, the model's ordered multiple outputs are
  animation frames. The host bounds the response to 100 frames, validates each
  downloaded image, and composes the frames into a GIF under the media-task
  queue. Models without this flag retain normal single-image behavior even if
  an adapter returns multiple outputs.
- **Video:** `model`, `prompt`, `duration` (seconds), `resolution` and
  `aspectRatio` (one of the model's each), `references` (`[{ mediaType,
  base64 }]`, pictures only), and `referenceMode` when there are references:
  `frame` (the first, and the last if there are two) or `reference` (a look
  to follow). A model's `referenceModes` lists the modes it takes, `frame`
  when it leaves them out. API 2.7 adds `imageAspectRatios` (with pictures) and
  `frameAspectRatios` (with first/last frames, taking precedence). With no
  pictures, `aspectRatios` applies; omitted overrides fall back to it. Each
  override must be a nonempty list of supported ratios and requires
  `maxReferenceImages > 0`; `frameAspectRatios` also requires frame mode.
  API 2.8 permits video `maxReferenceImages` from 0 through 30. A plugin that
  needs more than 16 must require `^2.8.0`; frame mode still takes at most two
  images, and image-generation models retain their 16-reference limit. Static
  and discovered models use the same schema. Sandbox memory and request limits
  remain unchanged; reference count does not guarantee that arbitrarily large
  input files fit.
  These lists may differ: a provider can offer only `adaptive` for frames
  while requiring a concrete text-to-video ratio. The picker and request
  validation use the same rule, including discovered models saved in Settings.
- **Audio:** `model`, `kind` (one of the model's), `prompt` (the words for a
  model that reads text, a description for the rest), `format` (one of the
  model's), `voiceId` for a model that reads text (the first static voice by
  default; account voices require an explicit choice), and when asked and the model takes them,
  `durationSeconds`, `instrumental`, `loop` and `language`. Speech can carry
  `speed`, from -50 (half as fast) to 100 (twice as fast), 0 when left out.
  Declared `speedRange` limits are checked before dispatch; explicit zero is
  retained. Equal range bounds declare a fixed rate: generation uses that rate,
  hides the speed control, and preserves the saved speed for switching back to
  another model. With `sampleRatesByFormat`, a requested `sampleRate` is checked
  against the chosen format, passed to the adapter, and verified against
  the downloaded audio. A mismatch fails without accepting the file or
  discarding the saved paid result. API 2.25 models may declare `channels: [1]`,
  `[2]` or `[1, 2]`. An explicit `output.channels` is rejected before HTTP unless
  declared, passed to the adapter as `channels`, and checked against the decoded
  file. Omit it to leave the choice to the provider. Previously ignored explicit
  channel selections now fail instead of accepting an unintended output; saved
  settings and paid receipts are retained. Languages remain provider-owned codes;
  the app exposes declared choices and passes the selected code unchanged.
- **3D:** `model`, `operation` (`text`, `image`, `retexture` or `remesh`), `prompt` for `text`,
  `references` (`[{ mediaType, base64 }]`, the first the front) for `image`,
  `targetPolycount` (in the model's range), and `texture` and `pbr`, each
  based on the model's defaults when not asked for explicitly (`texture`
  defaults to its capability, `pbr` to false). Processing inputs are below.

`outputs` are `{ url }`, which the app downloads without the key, or
`{ base64, mediaType }`; API 2.30 adds `{ url, auth: true }`, downloaded with
the key placed as `media.auth` says, for a result the vendor serves only to
its key holder; API 2.19 also supports the host-owned audio file
reference described below. A `url` must be on a `capabilities.network` host too,
so list the host the vendor's results are on (SiliconFlow's are on
`sc-maas.oss-cn-shanghai.aliyuncs.com`); a download elsewhere fails with the
host's name. The app checks what it got (an image must be PNG, JPEG or WebP, or GIF from API 2.30,
a video MP4 of at most 500 MB, audio a playable file of the format the
person picked, or when they picked none, any of MP3, WAV and Ogg Opus, since
some vendors don't say which file a model makes, and a 3D model a binary glTF (GLB) of at most 100 MB) and writes it to the
project, as a built-in provider's result is. A request takes the first output,
except animation, which combines every output into one GLB.

`host` holds:

- **`host.fetch(url, init)`**: HTTPS to the plugin's `capabilities.network`
  hosts. API 2.28 also permits HTTP on `127.0.0.1` or `localhost` only when
  that exact host and port are listed, for example `127.0.0.1:8188`. A bare
  hostname grant does not allow local HTTP; changing ports or hostnames needs
  its own grant. Default HTTP port 80 requires an explicit `host:80` grant.
  LAN/public HTTP, URL credentials and IPv6 loopback are not supported.
  Require `engines.ohmygame-api: "^2.28.0"` for local HTTP.
  - `auth: true` adds the key as `media.auth` says. `json` sends a JSON body.
    Where the answer to such a request repeats the key, in a header or the
    body, the adapter reads `[key]` instead.
  - The answer gives `status`, `ok`, a few headers (`content-type`,
    `content-length`, `retry-after`, `location`, `x-request-id`), and `json()`
    or `text()` of at most 20 MB, so a picture sent back as base64 fits.
  - Redirects aren't followed, and cookies aren't kept.
  - The same boundary applies to media output downloads, which never receive
    the provider key. Local HTTP support does not change project panels, MCP
    connections, preview URLs or chat providers. It neither starts a server
    nor installs models, and does not add image-generation recovery.
- **`host.submit(id, url, init)`** (API 2.9): the same network/auth boundary and
  response shape as `fetch`, with a durable receipt for one paid step. Require
  `engines.ohmygame-api: "^2.9.0"` when using it. It is available only inside
  `start` or `check` of a recoverable video, audio, 3D or opted-in image generation.
  - Use a stable, generation-local ID of 1–120 ASCII letters, digits or hyphens
    for each step, such as `preview`, `refine`, `rig`, or `animation-1`.
  - The host records the attempt before sending. Matching repeated calls reuse
    the saved response; a lost or unrecordable response refuses another request.
    The original provider/account, generation input, adapter bytes and step
    request must still match. Neither keys nor raw request bodies are stored in
    step receipts; responses are redacted as with `fetch`.
  - Responses, including HTTP error responses, are retained (at most 1 MB per
    response and 128 steps). A rejected later step does not discard earlier paid
    work. Check the provider before deliberately starting a new generation.
    Use ordinary `fetch` for status queries, including POST-based status APIs.
  - Await the call before using its result. If the adapter or waiter stops, the
    submission retains its write ownership until it settles; another attempt
    cannot race that receipt. A staged `start` can resume from its receipts,
    while an ambiguous raw write in `start` still prevents replay.
- **`host.log(message)`**: writes to the plugin's log.

A multi-step adapter uses `submit` for every paid request, including requests
made during `check`. For example, submit `preview` in `start`; after its status
succeeds, submit `refine` in `check`, then poll the returned task ID with `fetch`.
If `check` stops before returning its next task, its submission receipt still
survives. The outer task and all step receipts are removed only when the app has
stored the final artifact. Existing single-task adapters continue to work.

Task journals now write version 1. Older unversioned records migrate when their
owner loads them, retaining task IDs/results and ambiguous-start refusal.
Unknown fields or future versions are refused before mutation; read-only
inspection may count an opaque task without claiming it is resumable.

### Transcription (API 2.20)

Set `transcribes: true` on an audio model and require
`engines.ohmygame-api: "^2.20.0"`. A transcription-only model uses `kinds: []`;
a model must either produce an audio kind or opt into transcription. Existing
generation-only models keep their behavior. Transcription-only models appear
in the audio catalog but are not offered as generation defaults.

The `audio.transcribe(input, host)` step receives `model`, optional `modelData`
and `language`, and `audio: { file, mediaType, byteLength }`. This is a host-owned
snapshot of an audio/video input of 1 byte to 64 MiB. The script cannot read
its raw bytes, base64 or original filesystem path. Use its file handle in the
existing multipart interface:

```js
const response = await host.fetch("https://api.example.com/transcribe", {
  method: "POST", auth: true,
  multipart: [
    { name: "model", value: input.model },
    { name: "file", file: input.audio.file },
  ],
});
if (!response.ok) return { error: "Transcription failed" };
const result = await response.json();
return { text: result.text, language: result.language };
```

Return `{ text, language? }` or `{ error }`. Text is trimmed and limited to
1,000,000 characters; an optional detected language must be a nonblank string
of at most 40 characters. An empty transcript is valid (the canvas reports no
speech found). The host supplies the selected provider/model identity itself.
The optional input language is forwarded as given, including region codes;
the adapter converts it to the vendor's language format when needed.

Transcription uses the existing synchronous canvas flow. Calls have a five-minute
deadline and independent cancellation, recheck current plugin/key permissions,
and do not retry automatically. There is no task journal or background recovery
for transcription: `host.submit`, `host.reuse` and binary response mode are
unavailable. If a response is lost, another explicit attempt may incur another
vendor charge. All network, credential-redaction and multipart input ownership
checks still apply. This API does not activate a native-provider migration.

### Audio request diagnostics (API 2.21)

Audio outputs may include `requestId`, a nonblank string of at most 512
characters, alongside a URL, base64 or host-owned file handle. The host stores it
as `metadata.providerRequestId`, including after task recovery. Invalid IDs fail
without discarding a confirmed paid receipt or sending another paid request.
`host.fetch` and `host.submit` expose the `request-id` response header alongside
`x-request-id`; both are key-redacted. Other headers remain limited to the
existing allowlist. Require `engines.ohmygame-api: "^2.21.0"` when relying on this
metadata. An absent ID remains valid.

### Binary audio responses (API 2.19)

For speech, music or sound endpoints that return audio bytes directly, require
`engines.ohmygame-api: "^2.19.0"` and use a stable paid step:

```js
const response = await host.submit("speech", "https://api.example.com/speech", {
  method: "POST", auth: true, json: request, responseType: "file",
});
if (!response.ok) return { error: (await response.json()).message };
return { outputs: [await response.file()] };
```

Binary requests and audio adapter calls can wait up to five minutes, matching
the built-in audio request limit; cancellation and the provider's overall
`maxMinutes` deadline still apply. This is available only in a recoverable audio
`start` or `check` call. Plain
`host.fetch`, discovery and other media kinds reject `responseType: "file"`
before dispatch. A successful response is saved by the host; `file()` returns
an opaque `{ file }` reference, never a filesystem path or the audio bytes.
`text()` and `json()` reject successful binary responses. Non-success responses
retain the existing bounded, key-redacted text/JSON interface. The host inspects
the resulting audio and still enforces the requested format and sample rate.

Files and their total per generation are limited to 64 MiB. They are private
files alongside the task receipt, bound to its request identity and content
SHA-256. A replay reads and checks the same file, without another paid request;
missing, changed or linked files fail and keep the paid receipt. References
cannot read another task's directory or accept arbitrary local paths. Current
plugin permissions, account and request checks still apply before recovery.

Files stay until the caller stores the generated asset and clears the journal.
Cleanup refuses unknown filenames or directory layouts and retains the receipt,
rather than deleting data it cannot recognize.
An interrupted request that saved bytes but did not save its paid receipt remains
unconfirmed: retry refuses another submission. A confirmed receipt survives
process termination even before the adapter returns its outer result. This is
process-restart recovery, not a guarantee against storage-device failure.
Existing JSON task receipts and URL/base64 outputs keep their format; binary
responses add an opaque output reference and a task-owned `.files` directory.
Older hosts cannot load plugins requiring API 2.19. No native audio service is
switched by this API addition.


### Encoded audio receipts (API 2.23)

A recoverable audio `host.submit` with `responseType: "file"` may also specify:

```js
{
  requestIdHeader: "X-Api-Request-Id",
  decode: {
    format: "jsonl", // "json" for a single object
    audioField: "data",
    statusField: "code",
    successCodes: [0, 20000000]
  }
}
```

API 2.26 additionally accepts `encoding: "hex"` (the default remains `"base64"`)
and one to four field names for nested `audioField`, `statusField` and optional
`messageField`, for example:

```js
decode: {
  format: "json",
  encoding: "hex",
  audioField: ["data", "audio"],
  statusField: ["base_resp", "status_code"],
  messageField: ["base_resp", "status_msg"],
  successCodes: [0]
}
```

Paths read only own object fields; they do not evaluate expressions or traverse
arrays/prototypes. Audio and status paths cannot overlap. Hex must contain whole
bytes with no separators or prefix. The audio field is removed from nested
metadata while sibling fields remain. A failed status uses the configured message
field, or top-level `message` when omitted. Plugins using these additions must
require API 2.26; existing top-level Base64 options and confirmed receipts keep
their meaning. No stored-data migration or native provider cutover is needed.

The host decodes the audio field outside the sandbox, validates every
object's integer status and saves a single owned audio file before confirming the
paid receipt. JSON lines may cross network chunks; a final line needs no newline.
Audio is capped at 64 MiB, encoded input at its Base64 size (or twice the decoded size for hex) plus 8 MiB of framing,
and non-audio metadata at 8 KiB. Empty/invalid/truncated responses, rejected status,
invalid UTF-8 and exceeded limits fail without saving partial audio. A stream with
no vendor completion marker is complete only when its HTTP body ends cleanly;
this API does not invent a stronger vendor guarantee.

The response still exposes `file()`; file bytes never enter the VM or journal
JSON. `response.metadata` contains the latest top-level non-audio fields merged
across successful events, with credentials redacted. Unknown metadata is bounded,
not silently truncated. `text()` and `json()` still reject file responses.
Adapters validate vendor-specific metadata and may set an output's
`usageCharacters` and `originalDurationMs` to nonnegative safe integers; both are
retained in asset metadata. Original duration is the vendor-reported duration
before processing, which can differ from the decoded file's inspected duration
and may be the basis for billing. It never replaces the actual file duration.

`requestIdHeader` asks the host to generate a UUID only when the paid request is
actually sent. It must be a custom `X-` header, cannot replace a supplied header
or the credential header, and is returned as `response.requestId`. The generated
value is kept in the confirmed receipt, outside the original request fingerprint;
re-entering `host.submit` restores it without another HTTP request. Adapters must
not generate a fresh random request ID on each recovery. The redacted `x-tt-logid`
response header is also available for provider tracing.

Both options are limited to recoverable audio file submissions. Missing or
uncertain receipts keep the existing no-resubmission rule. Existing binary file
responses and older plugin declarations retain their behavior. These additions
require `engines.ohmygame-api: "^2.23.0"`.

### 3D processing and controls (API 2.11)

Declare `engines.ohmygame-api: "^2.11.0"` and `media["3d"].inputFiles: true`
to add a `processing` connection alongside generation `models`:

```json
"processing": {
  "id": "connection",
  "title": "Processing",
  "operations": ["retexture", "remesh"],
  "optionProfile": "meshy",
  "polycount": { "min": 100, "max": 20000, "default": 4000, "presets": [1000, 4000, 20000] },
  "texture": true,
  "pbr": true
}
```

Its ID must differ from generation model IDs, including discovered models. It
stays available when generation models are hidden, but respects the provider
switch, key and plugin permissions. Saved generation choices that collide with
a new processing ID remain stored and are excluded from the generation catalog.
Processing uses the same model fields, including `data` and `defaults`.
Its `polycount` defines the remesh bounds, default and canvas presets; retexture
does not validate an unrelated generation polycount.

Both operations receive `source: { file, mediaType, byteLength }`, a
host-owned snapshot of a GLB up to 100 MB, usable by the file request forms below.
Retexture requires a prompt or one reference image; remesh accepts neither.
Generation (`text`/`image`) cannot receive a source GLB. The adapter receives the
processing ID as `input.model`, the operation, `options`, and the usual texture,
PBR and target-polycount values. File handles and these inputs participate in the
durable task identity, so retrying a saved output does not submit another paid job.

Generation models and processing may choose `optionProfile` (`meshy`, `tripo`,
`hyper3d`) to reuse existing operation controls and option validation. This only
selects controls; all vendor requests still go through the plugin adapter.
Without a profile the generic controls apply. Animation, account balances and
shared rigging are described in the following sections.

A 3D output may include `forwardAxis: "+X" | "+Z"` and `requestId` (a nonempty
string up to 512 characters). They survive task recovery; the axis is stored in
Library model metadata so later processing knows the result's orientation.

### Low-poly model ranges (API 2.15)

3D model declarations may use face counts from 48 to 2,000,000, including
`polycount.min`, `max`, `default` and `presets`. Require
`engines.ohmygame-api: "^2.15.0"` for a declaration below 100. This accommodates
existing Tripo P1/P2 ranges; each selected model and processing operation still
enforces its own limits before generation. The canvas, agent tool and HTTP
request share the broad lower bound. A saved count is preserved while a plugin
model's catalog is unavailable, then checked against that model when used.

### 3D animation and action lists (API 2.12)

With `engines.ohmygame-api: "^2.12.0"`, a processing connection can include
`"animate"` in `operations`. It receives the same `3d.start`/`check`/`cancel`
calls, with `operation: "animate"`, `source` (a GLB file handle), `actionIds`
(1–30 distinct numeric or string IDs), optional `heightMeters`, `options`,
`forwardAxis` and `modelData`. Use `host.submit` for every paid rig/batch;
the ToolRunner retains the journal through download or Library-storage failure
and clears it only once the final asset is stored. Native historical tasks keep
their existing journal and provider ownership.

Set `processing.animationSourceAxis: "+Z"` when rigging requires that orientation.
The host rotates a known +X source before making its file handle, preserving
geometry, skins and animation transforms. Unknown orientation is treated as +Z,
as for native Meshy. The adapter sees the resulting `forwardAxis` and immutable
bytes; a changed source or request cannot resume a different paid task.

An animation response returns all batch GLBs in `outputs`. Up to 30 outputs are
accepted, each up to 100 MB, at most 200 MB in total, and a merged result up to
100 MB. Each must have a skin and animation clips; output axes must agree.
The host matches unique bone names, hierarchy, transforms and inverse bind poses
before merging. Duplicate clip names from later batches get suffixes. Missing/invalid outputs,
incompatible skeletons, and fewer clips than requested fail the operation;
paid results remain recoverable. Other kinds still use their first output.

Implement `3d.actions(input, host)` for the existing animation picker. It receives
`{ model, options?, modelData? }` and returns `{ actions: [...] }`. An action is
`{ id, name, category?, subCategory?, previewUrl? }`; IDs are distinct nonnegative
safe integers or nonempty strings up to 120 characters. Names/categories are
nonempty strings up to 256 characters; omitted categories use `Other`.
The library may be empty and is capped at 5,000 actions. Preview URLs must use
HTTP(S) on an approved network host and contain no URL credentials.

The action call has a 30-second deadline. Only GET/HEAD requests are allowed;
`host.submit`, writes and uploads are refused before HTTP. Existing network,
auth and redaction rules apply. Listing can therefore populate controls without
creating paid jobs. An unavailable library reports an error and can be retried.

### Account credits (API 2.14)

Set `media["3d"].balance: true` and `engines.ohmygame-api: "^2.14.0"` to show
the existing API balance section in the plugin's provider settings. The account
query is independent of generation model visibility and does not require a
processing connection. Settings shows it only while the provider is configured
and enabled. Free cloud quotas remain separate.

Implement `3d.balance(input, host)`, where `input` is an empty object. Return
`{ balance: 123.5, frozen: 4 }`: `balance` must be finite and may be negative
for an overdrawn account; optional `frozen` must be finite and nonnegative.
Amounts are credits, with at most three decimal places displayed. Unknown
response fields are ignored. Return `{ error: "..." }` or throw on failure;
the UI provides a refresh control to retry.

The hook has a 30-second deadline and can only use GET/HEAD on approved hosts.
Authentication and response redaction follow `host.fetch`; `host.submit`,
`host.reuse`, writes and uploads are refused before HTTP. This query must never
generate media or incur a paid submission. Each refresh reads the current key;
the UI discards obsolete responses after a key or provider change.

The existing `/model3d-balance` route uses the plugin provider ID and
`id=connection` for this provider-level query. A missing declaration, disabled
provider, absent key or revoked plugin permission fails before network access.

### Shared animation prerequisites (API 2.13)

Use `engines.ohmygame-api: "^2.13.0"` and `await host.reuse("rig")` from
`3d.start` or `3d.check` to share a paid rig across animation jobs. This requires
a recoverable animation; generation, listing and cancellation calls cannot use
it. IDs contain 1–100 ASCII letters, digits or hyphens.

Implement `3d.reuse(id, input, previous, host)`. `input` is the host's animation
input **without `actionIds`**. Its source bytes, model, height, axis, options and
model data, plus plugin/provider identity, account and package digest, determine
the shared scope. Do not rely on module globals: each hook has its own VM.

- When `previous === null`, submit paid work with `host.submit` and return
  `{ value: { taskId: "..." } }`. The non-null value must fit in 16 KB of JSON.
  Return the remote task identity promptly; poll long-running rig work in the
  animation's ordinary `check` hook. Unjournaled writes and nested `host.reuse`
  calls are refused.
- With a saved value, query the exact vendor task with GET/HEAD and return
  `{ valid: true }` if it can still be used, or `{ valid: false }` only for a
  confirmed unusable/expired task. Validate task ID, status and expiry according
  to that vendor's contract. A timeout, unavailable query or unknown status must
  throw. Validation cannot submit or upload. Throwing retains the paid record;
  it never triggers a replacement rig.

The daemon owns one in-flight hook per scope. Cancelling an animation only
detaches its waiter; another animation can join the same owner. Daemon shutdown
aborts owners and waits for their receipt writes. Hook calls retain the sandbox's
120-second deadline and existing network permissions, auth and redaction.
Changed credentials, permissions or package identity prevent further HTTP.

The shared store uses versioned task journals under `plugin-media-reuse/` in the
app data directory. Successful references are pinned to each generation's own
journal, so retrying an older job keeps its original rig even after a newer job
has replaced an expired shared rig. Failed read-only resolution is retryable;
an uncertain paid submission stays unconfirmed and is never resubmitted.
Internal `_reuse-` receipt IDs cannot collide with public `host.submit` IDs;
older hosts refuse journals containing them rather than discard paid state.
Malformed/future records are preserved and refused. Native historical jobs
continue using their original journals.

### Host-owned input files (API 2.10)

A 3D provider can opt into `media["3d"].inputFiles: true`, with
`engines.ohmygame-api: "^2.10.0"`. Its `input.references` then contains
`{ file, mediaType, byteLength }` instead of base64. Existing providers retain
their base64 contract. The host snapshots each input; a handle is bound to its
content and media type and is available only in this generation. It is not a
filesystem path. References must be PNG, JPEG or WebP, at most 20 MB each.

For multipart uploads, pass an ordered array to `host.fetch` or `host.submit`:

```js
await host.submit("reference-upload", "https://api.vendor.example/upload", {
  method: "POST",
  auth: true,
  multipart: [
    { name: "image", file: input.references[0].file, filename: "reference.png" },
    { name: "prompt", value: "A chair" },
  ],
});
```

File parts take a handle and an optional simple filename; text parts take a
string value. Repeated names are preserved. The host sets the boundary and
content length. Multipart cannot be combined with `json`/`body` or a GET/HEAD
request; at most 64 parts, 1 MB of text and 200 MB of file/text payload are
accepted. Network grants, explicit `auth`, credential redaction, deadlines
and redirect refusal are the same as ordinary `fetch`.

For a vendor that needs data URLs in JSON, use an explicit placeholder:

```js
await host.submit("generate", "https://api.vendor.example/generate", {
  method: "POST",
  auth: true,
  json: { image_url: { $mediaFile: input.references[0].file } },
});
```

The host expands placeholders before sending, outside the sandbox's memory.
A placeholder may specify `mediaType`, for example `application/octet-stream`,
when the vendor requires it. Other properties are refused. Expanded JSON is
limited to 200 MB. Unknown handles fail before HTTP. Handles remain stable for
the same bytes/type across restart, so paid-step receipts can reuse the same
request; changing a reference changes generation ownership and refuses replay.
The adapter never gets the raw bytes through this interface.

### The sandbox

The adapter runs in QuickJS compiled to WebAssembly (`quickjs-wasi`, MIT,
which the agent runtime already ships), inside the daemon:

- each call gets 64 MB of memory and 2 seconds of its own CPU time (waiting on
  `host.fetch` doesn't count), and 2 minutes in all. Image `start` gets 3 minutes,
  including its HTTP request, so synchronous image generation can finish within
  the built-in provider's budget. Other HTTP requests keep their 60-second limit;
  cancellation and the kind's overall deadline still apply;
- it has at most 4 `host.fetch` requests open at once, since their answers
  wait in the app, outside those 64 MB; a fifth fails until one is answered;
- there is no `fetch`, `require`, `process`, file system or clock beyond
  `Date`;
- the app reads only strings back from the VM, so nothing of the script's
  (a getter, a replaced `JSON.stringify`) runs outside these limits;
- an adapter that throws, runs out of memory or time, or returns something
  malformed fails that one request with a message naming the plugin.

So a media provider plugin asks for no `native` permission and shows no
warning that its code runs with the person's access. A third party's vendor
plugin is as safe to add as an official one.

### Listing the vendor's models

A vendor with hundreds of models, each taking its own fields, can't list them
all in the manifest. A kind with `discoverModels` has a fourth step:

- **`models(host)`** returns `{ models }`, each in the same shape as the
  manifest's models of that kind, or `{ error }`. It usually reads the
  vendor's model list and each model's input schema, and turns them into the
  fields OhMyGame knows (aspect ratios, durations, voices and so on), with
  `data` saying how to build a request for that model. A model it can't
  describe is better left out than listed wrong.

The app calls it only when the person asks, with **Load models** on the
provider's page in Settings, never in the background. The call may take 10
seconds of its own running time and 5 minutes in all, for a vendor whose list
spans many pages. Up to 2,000 models are kept per kind; one that fails the
manifest's checks is left out, and Settings says how many were.

Listed models stay off until the person turns one on; only models that are on
appear in model menus, the canvas and the agent's tools, as with a chat
provider's models. A model turned on is kept whole in
`plugin-media-models.json` in the app's data, so it works after a restart
without listing again, and a model the manifest lists can be turned off the
same way. Unknown store fields and hidden IDs missing from the current manifest
are retained. If any saved model or known choice is unreadable, changes are
refused without replacing the file. Reads also fail rather than silently using
manifest defaults in place of unreadable saved choices. Model choices returned to callers are
independent snapshots, and updates are validated before they are saved.

### Manual 3D versions and defaults (API 2.16)

Set `media["3d"].editableModels: true` and require
`engines.ohmygame-api: "^2.16.0"` to offer **Add** and **Edit** in the provider’s
model list. This is independent of `discoverModels`. People can rename presets,
change their default face count, count presets and texture/PBR defaults, or
restore the plugin’s current defaults. Preset capabilities remain fixed.
**Add** copies a manifest template into a manual vendor model ID; people can
then adjust supported generation operations, reference limits, face-count
ranges, and texture/PBR support. Adding a version does not contact the vendor.
Its ID and limits must match a version supported by the adapter and vendor.
At submission, validation, defaults and adapter metadata use one current model
definition, even if the caller loaded its catalog before an edit completed.

A template can declare `modelSettings: { imageOperation, modelType }` to expose
its generation modes: `imageOperation` is `image-to-3d` or `multi-image-to-3d`;
`modelType` is `standard` or `smart-topology`. Single-image mode requires one
reference, and smart topology requires single-image mode. Generation passes
these values as `input.modelSettings`; the adapter must implement them. The
host does not infer modes from opaque `data`, nor change vendor endpoints.
Templates that omit these settings do not offer mode editing.

The editor preserves template-owned `data`, option profiles, descriptions,
view labels and credit estimates. Saved definitions are complete snapshots:
plugin upgrades do not overwrite them, even if a new preset uses a custom ID.
Adapters must continue to understand the saved data, or reject unsupported
versions explicitly. **Restore defaults** replaces a preset override with the
current manifest. Removing a custom definition that now collides with a
manifest preset leaves that preset hidden. Hidden manual versions remain
editable and survive restart; removing one does not delete generated assets.
A plugin that drops editing support, or reuses a saved generation ID as its
processing connection, fails rather than silently falling back to presets.

`plugin-media-models.json` version 2 adds `definitions: [{ custom, model }]` to
each 3D choice, alongside its existing `added` and `hidden` lists. Version 1
migrates atomically on load, retaining unknown metadata; an existing version-1
`3d.definitions` extension is refused, not reinterpreted. Unknown versions or
invalid definitions are never overwritten. Each edit carries a revision of
the plugin package and saved choices, checked inside the serialized write.
A stale form keeps its draft and reports the conflict; cancel and reopen it to
load current definitions before editing again. This compatibility reader may
be removed from beta.7 after 2026-12-14, following the compatibility policy.

## Tasks: polling and events

Inside the app, everything is event driven. A request's result or failure
reaches the canvas and the agent's tool call the way a built-in provider's
does, and the progress an adapter reports is sent the same way. Nothing on
screen polls.

Toward the vendor, polling happens only when the vendor offers nothing
better, and the adapter decides the pace:

- `check` returns `retryAfter` in seconds, from the vendor's `Retry-After`
  or its own estimate. The app keeps it between 1 and 60.
- Without one, the app waits 2 s, then longer each time, up to 15 s.
- A check that fails, such as on a network blip, is tried again twice
  before the task is given up.
- Checks run only while a task is running, and the whole task gives up after
  the kind's limit (image and audio: 10 minutes; video and 3D: 15 minutes,
  the download included). A provider whose work takes longer, such as a
  self-hosted model or a vendor with a long queue, sets `maxMinutes` on the
  kind, up to 120.
- Webhooks aren't used. A desktop app has no public address for a vendor to
  call, and a relay of our own would cost money and see people's prompts.
  Streaming answers (`text/event-stream`) can be added to `host.fetch` when a
  vendor needs them.

A video's, a 3D model's or an audio file's task survives a restart, as a
built-in 3D job's does (`model3d-journal.ts`).
The app keeps the task value under the generation's recovery id
(`media-tasks/<id>.json` in the app's data), writing it before `start` and
whenever `check` changes it. A generation the restart cut off shows as
interrupted; **Retry** checks the same task again instead of starting a new
one:

- While the app shuts down, it doesn't call `cancel`, so the vendor goes on.
- Repeated check failures retain the submitted task without calling `cancel`.
  Retry checks that task again; it never pays for a replacement submission.
- When the person stops or time runs out, the app attempts optional `cancel`
  and retains the task. Local cancellation is not proof of a remote terminal
  state. The journal stays leased until the bounded cancellation attempt ends,
  so a retry cannot race it. The next retry queries the original task; an
  explicit terminal error then clears the journal. A new generation is a
  separate intentional action.
- Stopping or failing a result download retains the paid result for retry.
- A paid `start` is never repeated for the same request. If a `start` request
  was sent but no answer came back, the retry is refused with a message to
  check the vendor's site. So is a retry whose provider or request changed.
  An adapter keeps this guard by throwing, not returning `{ error }`, when
  the vendor may have taken the request (a 5xx, or a success it can't read).
- The task stays until the result is stored in the project, so a download or
  a write that failed is retried by checking the task again (for a fresh
  address), not by paying for a new one. For a vendor that answered at once,
  with no task, the app keeps the result's address instead.

Agent tool calls that a restart cut off aren't retried, since the agent's turn
ended with them. Images, which rarely take a task, start again.

## In the app

- `PluginMediaProviders` (`src/daemon/plugin-media-providers.ts`) reads
  installed plugins' media sections. It adds their models to the image,
  video, audio and 3D catalogs under the provider's id
  (`plugin.<publisher>.<name>.<id>`), only while the key is set and the
  provider is on. An audio provider's voices are listed as an account's are.
- Requests for those models go to the adapter through the sandbox.
  Everything after the result (checking it, saving it, the Library, undo) is
  shared with built-in providers.
- Settings → Providers shows what a provider makes from what it declares, and
  on its page, its models of each kind, each with a switch, and **Load models**
  for a kind that lists the vendor's (`src/renderer/plugin-media-models.tsx`).

## Market

The index adds each plugin's `providerKinds` (`language`, `image`, `video`,
`audio`, `3d`), taken from its manifest. Under **Model providers**,
Discover shows a second row of chips for the kinds something is in, and each
card shows small tags for its kinds. The author doesn't write these
separately: they are the kinds the provider has to implement anyway, so a tag
can't promise what the plugin doesn't do.

## Order of work

1. The sandbox, `host.fetch`, and image `start`. This includes the official
   SiliconFlow plugin's images, end to end. *Done.*
2. Video, with tasks, `check`, `cancel`, `retryAfter`, and resuming after a
   restart. *Done.*
3. The market's kinds: the index field, the chips under Model providers, and
   the tags on cards. *Done.*
4. Audio (speech, sound effects, music) and 3D from a prompt or pictures.
   *Done.*
5. Listing the vendor's models (`discoverModels`, `models`, a model's `data`),
   with switches in Settings. *Done.*
6. Vendor migration starts with an optional MiniMax video adapter and the
   reference-ratio contract above. Existing builtin keys and model references
   remain until a separate migration is verified against a published package.
   Follow [#809](https://github.com/WhiteTowerAI/ohmygame/issues/809).
7. 3D retexture and remesh are available in API 2.11; animation and its
   action library in API 2.12, shared rigging in API 2.13, balances in API 2.14,
   low-poly ranges in API 2.15, and editable model definitions/defaults in
   API 2.16. Audio limits and rates are available in API 2.17, account voices
   in API 2.18, recoverable binary audio in API 2.19, and transcription in
   API 2.20. Vendor plugins and compatibility activation remain separate from
   host API support; see the migration sections below for saved settings,
   references and unfinished task ownership.


## Stored settings before vendor migration

MiniMax's existing keys stay in `minimax.json` until activation is verified. The
version-1 key store preserves unknown fields when either regional key changes or
is cleared; clearing the last key removes the file only if no other data remains.
Model preferences in `model-visibility.json` likewise retain unrelated fields and
metadata on unchanged default model references. Invalid or newer files cannot be
rewritten after a failed load; repair and reload them before editing.

Plugin configuration retains unknown root and field metadata. A damaged record,
unknown field type or future file version makes the store read-only instead of
silently filtering that record out on the next save. Secrets remain typed and are
not exposed to native plugin code without its secrets capability. These storage
protections prepare the optional vendor migration; they do not copy keys, rename
saved model references, enable a plugin, or replace a built-in provider.

### ElevenLabs Beta package verification

`@ohmygame/elevenlabs@0.1.0` was published from
[official plugins #25](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/25).
The npm registry signature, tarball SHA-512, all nine packaged files against the
reviewed source, and the host package digest were verified. It requires API 2.21
and declares `beta: true`. The market record, index checksum and served logo
also match the verified release. Provenance is published by the release workflow;
the local verification here validates the registry signature, not SLSA provenance.

`ELEVENLABS_MIGRATION_PACKAGES` locks those actual published bytes. Preparation
extracts them as disposable integration fixtures; they do not enter the
preinstalled plugin index. The read-only package gate requires one matching
managed npm installation, current verified index metadata and all existing
app-wide permission grants. Changed files, unreviewed versions, disabled or
project-only installations and missing grants hold migration. The gate never
installs/enables a plugin or changes settings. Native cutover still requires
real-account acceptance and the remaining startup migration work.

### Combined migration preflight

After `bun run prepare:preinstalled-plugins`, quit the app and copy its data
and any selected project directories into private test folders. Keep the original
profile closed while copying. Run from the current `dev` checkout:

```bash
bun run inspect:media-migrations --data-dir /absolute/path/to/copied-app-data \
  --workspace /absolute/path/to/copied-project
```

This offline command combines the existing MiniMax, Seedance, ElevenLabs,
Doubao, Meshy and Tripo settings rehearsals. It makes no vendor requests,
installs nothing, and does not activate migrations or release anything.
Rehearsals write only disposable settings copies and check reload, idempotency,
rollback and cleanup. Source settings and migration-record bytes are compared
before and after the combined run. Do not use a live profile: the comparison
can detect changes but does not lock out a running app.

A validated committed receipt reports `committed` without proposing to copy the
old key/defaults again. This verifies historical ownership, not current plugin
installation or account health. An interrupted transaction or invalid committed
receipt, including a Hyper3D preparation record, blocks all settings rehearsals
because providers share configuration files. The command never repairs or deletes
these records; resolve recovery through the owning app before taking another copy.
Other provider-specific failures do not hide independent results. Missing or
mismatched prepared 3D fixtures report `rehearsal-unavailable`; rerun preparation
and inspect its output before retrying.

`--workspace` may be repeated; it runs the existing **MiniMax-only** canvas,
job and recovery-journal inspection. Without it, workspace checks explicitly
report `not-requested`. It does not inspect other providers' saved references or
unfinished jobs. `passed` means only the requested offline checks passed;
`activation` remains `held`, and the report lists outstanding acceptance,
installation/grant and cutover checks. Exit codes are 0 for passed, 1 for a
reported blocker, and 2 for invalid arguments or unreadable source snapshots.
Only fixed identifiers, reason codes and counts are emitted, never keys, paths,
custom model names or parser errors. There is no `--apply` option.

The original provider-specific commands remain available. See the
[Beta acceptance checklist](plugin-beta-testing.zh-CN.md#媒体插件与迁移验收)
for the real generation and restart checks that this report cannot replace.

### ElevenLabs settings inspection

The optional ElevenLabs Beta adapter requires API 2.21 and includes speech,
sound effects, music, account voices and Scribe transcription. Publishing it
and activating legacy-settings migration are separate steps. The native service
is still available; this inspector does not switch it.

```sh
bun run inspect:elevenlabs-migration --data-dir /path/to/copied-app-data
```

This reads only `elevenlabs.json`, plugin configuration and model preferences.
It reports whether the key can be copied, provider enabled/hidden choices agree,
and speech, sound-effect and music defaults match the reviewed model kinds.
Scribe is included in visibility checks but cannot become a generation default.
Unknown models, conflicting target choices and unreadable/future stores block
migration. The report contains no keys, hashes, arbitrary model IDs or parser
input. Exit codes are 0 for no settings blockers, 1 for blockers and 2 for invalid
arguments or an unavailable directory.

Even a clear report remains `activation: "held"`: it does not verify installation,
grants, the published package, live generation, saved canvas references or jobs.
It writes no settings, never enables a plugin and sends no vendor requests.
Native unfinished audio has no durable vendor task to poll; it must retain its
owner and cannot be rewritten into an automatic plugin resubmission. Transaction,
reference and old-task handling remain separate preparation work.

### ElevenLabs settings rehearsal

```sh
bun run rehearse:elevenlabs-migration --data-dir /path/to/copied-app-data
```

The rehearsal reads the same three files, creates a disposable private copy,
applies the proposal there, reloads the owning stores, checks idempotence, and
rolls back to the exact original bytes. It then removes the copy and verifies
that the supplied files did not change. Source credentials, unknown metadata,
plugin switches and unrelated providers stay untouched; only an unoccupied
plugin key, matching provider preferences and reviewed audio defaults may move.
Reports contain counts and fixed failure codes, never settings values.

The underlying transaction has ElevenLabs-specific receipts, uses the native
credential file as a read-only guard, and recovers interrupted writes before a
new attempt. This command never installs/enables the plugin or commits changes
to the supplied directory. Startup activation, package-integrity gating, canvas
references and old-task retirement are still held for separate implementation
and real-account acceptance. Remove this compatibility path only after that
migration's retained profiles/tasks are handled, no earlier than beta.7 and
2026-12-15.

### Seedream / Seedance beta and settings inspection

`@ohmygame/seedance@0.1.0` is an optional Beta published from
[official plugins #20](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/20).
It requires plugin API 2.8 and provides three Seedream image models and four
Seedance video models. Its npm signature, integrity, packaged files and market
entry have been verified. Local acceptance has passed for Ark image/video
generation and restart recovery, and for BytePlus credentials and video. The
application must still complete transactional migration and reference/job
handling before switching existing built-in providers.

The application pins that release's npm SHA-512 and indexed directory digest in
`src/daemon/seedance-migration-package.ts`. Its read-only package preflight accepts
only one active, managed npmjs/npmmirror installation with matching files and
cached metadata, compatible API, and all required every-project grants. An edited
package, development folder, ambiguous release, stale index or missing grants
refuses migration. The shared checker also protects existing MiniMax migration.
Plugin preparation extracts the integrity-checked Seedance package only as a test
fixture; it does not add it to the preinstalled index or enable it. Startup uses this package boundary before migrating settings.

Ark images and videos share `seedance.json`'s `volcengineApiKey`; the plugin uses
`arkApiKey`. BytePlus retains an independent `byteplusApiKey`. To inspect settings,
close the app and copy its data directory to a private local folder, then run:

```bash
bun run inspect:seedance-migration --data-dir /path/to/copied-app-data
```

The command reads `seedance.json`, plugin configuration and model preferences.
It reports one key decision per region, combined image/video visibility for Ark,
and separate image and video default mappings. Conflicting keys or target
preferences, unsupported models, incompatible key slots, and unreadable stores
block migration. Unknown IDs, arbitrary metadata and credentials never appear
in the report; all files remain unchanged. A successful report still has
`activation: held`: it does not verify installation/grants, inspect workspaces
or paid tasks, migrate settings, or switch a provider. Exit status is 0 for no
settings blockers, 1 for reported blockers, and 2 for invalid arguments or an
unreadable data directory.

Existing Seedance settings preserve unknown fields through key edits and clears,
and failed loads refuse later writes until a successful reload. The
[plugin's local testing guide](https://github.com/WhiteTowerAI/ohmygame-plugins/blob/main/plugins/seedance/README.md#local-testing--本地测试)
covers generation and restart acceptance. Legacy built-in video jobs do not
persist vendor task IDs; their inputs must not be replayed as new plugin tasks.

### Seedance settings rehearsal

Run `bun run rehearse:seedance-migration --data-dir /path/to/copied-app-data`
to exercise the proposed migration on an additional disposable private copy.
It maps the shared Ark key to `arkApiKey`, retains the independent BytePlus key,
copies provider visibility, and maps image and video defaults while preserving
unknown metadata. The legacy file is never rewritten. Conflicting or unreadable
settings stop the rehearsal before any staged write.

The rehearsal verifies reloading, idempotence and byte-exact rollback, removes its
temporary copy, and checks that the input files remain unchanged. Reports contain
only counts and fixed statuses, never credentials. There is no `--apply` option.
Success remains `activation: held`; package authorization, workspace references,
historical task handling and application startup activation are separate checks.

Seedance and MiniMax use the same settings transaction engine with separate
vendor receipts. MiniMax's version-1 receipt filenames and schema remain
unchanged. Seedance's `.seedance-settings-transaction.json` records complete
before/after bytes before writes; uncommitted recovery restores the original
settings, while `.seedance-settings-committed-v1.json` retains a committed
backup. Neither recovery nor commit can rewrite the legacy credential file.
The caller must own the profile and exclude live settings consumers; no Seedance
activation is introduced by the rehearsal command.

### Seedance startup settings migration

After acquiring exclusive profile ownership, startup recovers interrupted MiniMax
and Seedance transactions before either migration can write shared configuration.
An already installed and enabled, exactly verified Seedance 0.1.0 package can
then receive the regional keys, provider visibility and image/video defaults.
Startup reloads the staged settings and rechecks the package before committing;
a failure restores original settings. Safe mode, conflicting settings or a
package/grants mismatch defer activation without changing settings.

The original `seedance.json` remains byte-identical for legacy task ownership.
A committed receipt prevents later startups from restoring a key or preference
the user deliberately changed. Saved canvas and project references migrate separately on owning loads as
described below. Settings migration does not resubmit historical jobs. Committed profiles retire
the built-in providers as described in [Seedance cutover](#seedance-committed-profile-cutover).

### Optional MiniMax beta artifact

The reviewed migration targets are `@ohmygame/minimax@0.1.0`, `0.1.1`, `0.1.2` and `0.2.0`,
published from [official plugins #17](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/17),
[#18](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/18) and
[#19](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/19), with the speech expansion
in [#29](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/29) (`0.2.0`). Version `0.1.1`
updates the English/Chinese migration guidance. Version `0.1.2` requires API
`^2.8.0` and documents retained task ownership after local stop or query/download
failure. Version `0.2.0` requires API `^2.26.0` and adds Speech 2.8 HD/Turbo and six
system voice presets. Its video adapter, video models, regional key fields and
network grants retain the behavior of the three earlier releases.
Exact npm SHA-512 integrity and indexed package digests are pinned in
`src/daemon/minimax-migration-package.ts`.

All four published artifacts passed npm signature and integrity checks and the
app's plugin validator; their packaged files match the tested source. They declare
`beta: true`; `0.1.0`/`0.1.1` remain compatible with API `^2.7.0`. Each provides
regional `cn`/`global` video providers using `cnApiKey`/`globalApiKey`, with
`MiniMax-H3` and `MiniMax-H3-Max` models. They remain optional and outside the
preinstalled lock.

Live generation, downloading and quit/reopen recovery acceptance has passed for
video adapter shared by these releases. The new speech capability requires its
own local acceptance; video acceptance does not establish speech quality or
account access. Tests also upgrade an interrupted video from actual `0.1.2` to
`0.2.0` bytes without a second creation request or changes to keys and switches.
For subsequent adapter changes, repeat the
[plugin's local test instructions](https://github.com/WhiteTowerAI/ohmygame-plugins/blob/main/plugins/minimax/README.md#local-testing--本地测试).
Startup checks the single active installed version against its reviewed package;
another release or ambiguous index defers migration. Build preparation verifies
each archive into `.runtime/minimax-migration-packages/<version>/source` and tests
startup migration and recovery against each release. These disposable fixtures
are not added to the preinstalled index.

### MiniMax startup settings migration

After profile ownership and recovery, before constructing the app, startup can
migrate legacy MiniMax settings to an **already installed and enabled** optional
`0.1.0`, `0.1.1`, `0.1.2` or `0.2.0` plugin. It reindexes the managed package
files and compares their digest
to the reviewed SHA-512-verified release. The cached index must agree with those
files, its origin must be npmjs/npmmirror for `@ohmygame/minimax`, and its current
grants must enable every-project use and include all declared capabilities.
Safe mode, development/local sources, an unreviewed release, edited files, incomplete
grants or a disabled switch defer migration without changing settings. No plugin
is installed or enabled by this migration.

The shared preflight and proposal copy missing regional keys as secrets, preserve
existing keys and unknown metadata, carry hidden/disabled provider preferences
and map the saved default video model. Conflicts defer the entire migration.
Startup writes the recovery receipt first, validates freshly loaded target stores
and rechecks the package before committing the private backup. Failure restores
the original settings; interrupted writes recover on the next start. After commit,
normal edits, including clearing a plugin key, are never overwritten by another
copy from legacy settings. Only fixed reason codes are logged for deferrals.

Committed migration also enables the project, canvas and provider cutover
described below. Historical generation inputs keep their existing provider IDs. No job or vendor task journal is
rewritten, resumed or submitted during settings migration. Runtime smoke uses
the actual published package and temporary canary keys without vendor requests.

### MiniMax settings inspection

MiniMax is available as the optional `@ohmygame/minimax@0.2.0` beta (OhMyGame
API 2.26). The three earlier reviewed releases remain valid migration targets.
Publication alone does not enable migration or replace the built-in
provider; startup must commit the profile migration described above. To inspect
migration inputs, close the app and copy its data directory to a private local
folder, then run from this repository:

```bash
bun run inspect:minimax-migration --data-dir /absolute/path/to/copied-app-data
```

The command reads `minimax.json`, `plugin-store/configuration.json` and
`model-visibility.json` through their existing stores. It does not start the app,
execute plugins, contact MiniMax, write files or offer an apply option. Missing
files are treated as unset; a missing data directory is an error. Use a consistent
copy: reading a live app's files does not provide a transactional snapshot.

The JSON report separates China and Global mappings:

| Built-in provider | Plugin provider | Key field |
| --- | --- | --- |
| `minimax-video-cn` | `plugin.ohmygame.minimax.cn` | `cnApiKey` |
| `minimax-video-global` | `plugin.ohmygame.minimax.global` | `globalApiKey` |

Key decisions are `absent`, `copy`, `same`, `target-only`, `conflict`, `invalid`
or `blocked`. Different existing keys require a decision; an occupied but
incompatible target field is never treated as empty. Values that exceed the
plugin's length limit or violate the legacy key format are flagged. The report
contains no keys, hashes, arbitrary stored metadata or parser error text.

Visibility reports retain each provider's on/off setting and hidden H3/H3 Max
models. An explicitly saved target setting that differs is marked `review-target`;
unknown hidden models or an unknown built-in video default require review. A
known built-in default is shown with its proposed provider mapping. Unrelated
defaults remain unchanged. None of these proposed actions are executed.

Exit code `0` means no settings blockers were found, `1` means the report contains
blockers, and `2` means invalid arguments or a data-directory error. Every report
says `scope: settings-only` and `activation: held`, even when it exits with `0`.
It does not check installation, plugin enablement, project overrides, saved canvas
references, unfinished jobs or recovery journals, and cannot authorize a cutover.

Add one or more copied project directories to inspect canvas references and
history alongside the settings:

```bash
bun run inspect:minimax-migration --data-dir /absolute/path/to/copied-app-data \
  --workspace /absolute/path/to/copied-project-one \
  --workspace /absolute/path/to/copied-project-two
```

This produces report version `2`, with `scope: selected-workspaces` and
`activation: held`. The settings-only invocation remains version `1`. Workspace
numbers in the report follow argument order. Project registration and complete
project coverage are not verified: it never loads or rewrites the app's project
registry. Copy the app data and selected projects while the app is closed.

- Canvas inspection reads the index and every `canvas/boards/*.json`, including
  unindexed boards. Missing, unindexed, unreadable and future-format boards need
  review. Counts distinguish built-in and plugin MiniMax references and unknown
  model IDs. Existing schema and cross-node checks still apply; editor layout
  files are read as part of board validation, without saving normalized data.
- Job inspection reads `canvas/jobs.json` without creating a canvas, marking
  running jobs interrupted, or saving history. The application's ordinary load
  path still performs its existing interruption handling. Retry ownership comes
  from saved `input.model`, not the current board or display model; disagreement,
  unsupported input, mixed project histories and repeated recovery IDs require
  review. Failed and cancelled MiniMax jobs are included with running jobs.
- All `tools/media-tasks/*.json` in the selected app data are counted as unconfirmed,
  task-recorded, result-recorded or unreadable. Temporary writes are flagged.
  Recovery-ID matches to selected histories are associations only: the journal
  stores an opaque fingerprint, not a readable provider identity. Unattributed
  records may belong to other projects or agent calls; shared IDs may be retry
  history. None are deleted, claimed, rehashed or treated as safe to resubmit.
  A recorded task/result is not proof that the provider can still resume it.

Any unfinished MiniMax job or existing media journal keeps an ownership-review
blocker, including journals that might belong to another provider. The legacy
MiniMax generator has no persisted vendor-task recovery; a missing journal does
not prove that no paid request was sent. Do not automatically retry it through
the plugin. Preserve historical job inputs, recovery IDs and request fingerprints
when planning board-reference migration, and retain the legacy path until those
jobs have an explicit disposition. The report omits paths, prompts, task payloads,
result URLs, arbitrary IDs and fingerprints. Linked canvas or journal files are
rejected. Exit codes retain the settings inspection's meaning.

Before removing the built-in path, complete these separate gates:

- Verify real generation, result download, stop and restart recovery in both
  regions with the optional adapter. Retrying a recovered request must not start
  a second paid generation. Local stop does not imply vendor cancellation.
- Verify the installed package against the exact beta artifact above, including
  its integrity and provider/model contract. Publication and artifact checks do
  not establish local installation, grants, enablement or live acceptance. The
  settings migration enforces this baseline; the standalone inspector only reads
  settings and selected workspaces.
- Define the migration at each owning load boundary: keys in the key/configuration
  stores, switches and defaults in model preferences, saved references in canvas
  loading. Preserve unknown metadata and refuse unreadable files. Do not bulk-edit
  projects through startup helpers that also persist unrelated state.
- Classify unfinished jobs and task journals before changing any model reference.
  Keep recovery IDs, request fingerprints and provider ownership stable; retain
  the legacy execution path for outstanding work rather than resubmit it.
- Implement a resumable apply with conflict checks and rollback. Re-read settings
  before applying, preserve independently configured plugin values and switches,
  and keep legacy keys and providers usable until cutover succeeds. Specify the
  compatibility removal release/date when that migration first ships.

### Rehearse settings migration on a disposable copy

With the app closed, use a private copy of its data directory:

```bash
bun run rehearse:minimax-migration --data-dir /absolute/path/to/copied-app-data
```

The rehearsal copies only `minimax.json`, `plugin-store/configuration.json` and
`model-visibility.json` into a temporary directory. It refuses linked settings
files or directories. On POSIX, the temporary directory is mode `0700` and files
are `0600`; Windows uses the current user's temporary-directory permissions.
There is no apply, output-directory or keep-copy option.

After the existing settings inspector accepts the copied data, the rehearsal:

- Saves a private, versioned transaction journal before changing settings. It
  records byte-exact before/after snapshots and a checksum for corruption
  detection. The legacy key file is a read-only guard.
- Copies each regional key only into an empty compatible target. Existing
  matching keys remain, while conflicts and independently changed target switches
  block the proposal. Legacy keys and provider choices stay intact.
- Copies explicit hidden-model and disabled-provider choices and remaps a known
  built-in video default. It preserves unrelated data and extra metadata on the
  default reference, changing only its provider field.
- Reloads the staged files through the owning stores and verifies that a second
  proposal makes no changes. It then rolls back changed files to their exact
  original bytes, removing target files that were originally absent.
- Refuses rollback over an unexpected edit in the temporary copy, reports partial
  write/rollback failures, and removes the temporary directory on completion or
  caught errors. A final byte comparison detects source settings that differ
  from the initial snapshot; it never restores over a changed source file.

The report contains fixed statuses and counts only, with
`scope: temporary-settings-copy` and `activation: held`. Exit `0` means all
attempted rehearsal checks passed, `1` means blocked/failed, and `2` means invalid
arguments. Unattempted checks are `null`. It does not expose keys, file paths,
raw exceptions or the staged documents. Empty or already mapped settings produce
no proposed changes and still exercise reload and rollback verification.

This is a settings rehearsal, not an application migration. Its transaction
protocol is exercised only on an exclusively owned private copy. It neither scans nor rewrites projects, jobs, recovery
journals, plugin grants or installation state. It does not validate the eventual
published package, call MiniMax or activate a provider. Source comparison is not
a transactional snapshot across files; use a consistent copy while the app is
closed. Process termination or machine failure may leave a private
`ohmygame-minimax-rehearsal-*` directory in the system temporary directory; remove
that leftover copy locally. Cleanup failures are reported explicitly.

#### Recoverable settings transaction

The rehearsal uses `src/daemon/minimax-settings-transaction.ts` and keeps its receipt
at `.minimax-settings-transaction.json` inside the temporary copy. The version-1
receipt contains credentials (base64 is not encryption) and is written as `0600`
on POSIX inside the `0700` copy. It has `applying`, `applied`, `rolling-back` and `rolled-back` phases. Settings
writes use a flushed temporary file and atomic rename. Recovery reads the saved
receipt and file bytes, so termination after a file rename but before the final
receipt update does not repeat a completed change. A saved rollback intent is
sticky: recovery continues rollback rather than applying again. Rollback restores
exact original bytes and removes target files that were originally absent.

Before the first change and each subsequent write, all three known files must
match the recorded before or after bytes. Unexpected edits, linked files or
journals, corrupt checksums, unknown receipt fields and unsupported versions block
recovery without discarding the receipt. A completed receipt also requires its
exact terminal state. A second prepare cannot replace a pending receipt. Only
byte-exact completed rollback permits receipt removal; successful apply retains
its backup. The enclosing disposable rehearsal still cleans up on caught failures.
The checksum detects corruption; it does not authenticate a user-edited receipt.

Calls for the same canonical directory serialize within one process. This is not
an inter-process lock: one process must exclusively own the copy, and a recovery
process may start only after the previous one has exited. Tests kill real Node
workers at settings and receipt boundaries, including partial rollback, and
recover from disk in a new owner. File flushing does not establish portable
power-loss durability of directory entries; machine/filesystem failure remains
outside this increment's guarantee. The rehearsal CLI still operates on a disposable
copy and offers no apply/resume switch for real profiles.

The daemon calls startup recovery after acquiring profile ownership and before
creating the application. Any active receipt is **uncommitted**, including an
`applied` receipt whose file writes finished: startup restores its exact original
settings and removes the active receipt only after rollback completes. Interrupted
rollback resumes from the same saved intent. Unknown receipts, conflicting edits,
linked stores or simultaneous active and committed records stop startup before
settings caches or plugin connections exist. No fallback serves partial settings.

The activation owner can seal a validated `applied` transaction by atomically
renaming its receipt to `.minimax-settings-committed-v1.json`. The committed receipt
retains the original and target bytes as a private backup; it is never overwritten
by a new prepare or commit. A crash before that rename rolls back on startup; a
crash after it keeps the committed settings. Committed configuration can then be
edited normally: readers validate backup schema, phase and checksum, not equality
to the historical target bytes. The startup settings migration uses this commit
boundary only after installed-package and target-store validation.

#### Application settings ownership

The daemon gives MiniMax and Seedance credentials, plugin configuration (through
`PluginServices`) and model preferences one `SettingsWrites` owner. Each store's
`load()` joins the same queue as its mutations: it waits for earlier saves and
publishes its cache before later saves can read it. A failed or unsupported load
keeps that store read-only until a successful reload. Plugin uninstall continues
to preserve unreadable configuration, and unrelated stores can still be edited.
Configuration URL checks and pairing expectations use the values at execution
time. Custom-model edits and legacy model imports also read and modify their
settings inside the owner, preserving intervening changes.

Provider removal can await credential removal in the same operation. Calls into
another store share the owner; re-entering an already active store is rejected
rather than deadlocking. Nested writes drain before a failed operation releases
the queue. A later callback carrying an expired async context queues normally.
The owner is scoped to one daemon instance, with standalone store instances
owning separate queues. It is not a cross-process lock or a transaction for
synchronous readers; grouped reloads do not yet publish a single atomic snapshot.
Startup recovery finishes before these stores are constructed, so initial caches
all read the restored or committed disk state. There is no live migration/reload
endpoint; a future live endpoint would need a separate read barrier.

The daemon entry point enforces [profile ownership](runtime-recovery.md#profile-ownership)
and settings migration before loading the application. Committed profiles apply
the cutover below; live acceptance is tracked separately in the rollout plan.
Settings recovery
does not rewrite canvas jobs or vendor task journals, change recovery IDs, enable
a plugin, or submit vendor requests. Unmigrated profiles retain the built-in execution path; committed profiles
refuse unsafe legacy retries. A passing rehearsal alone does not enable cutover. The startup
migration records its compatibility removal release and date at its owning boundary.

### MiniMax saved canvas selections

After startup validates a committed MiniMax settings migration, the app moves
saved video-node selections from `minimax-video-cn` / `minimax-video-global` to
`plugin.ohmygame.minimax.cn` / `plugin.ohmygame.minimax.global` when their board
loads. Only the reviewed `MiniMax-H3` and `MiniMax-H3-Max` identities move.
Unrelated providers and unsupported model IDs remain unchanged. Incoming board
saves use the same mapping so a successful save returns the persisted selection.

Board reads and writes share the canvas workspace queue. Migration validates the
whole board, changes its raw model references, and atomically replaces only that
board file. It does not save normalized editor layout, touch the project order,
start generation, or edit history and recovery journals. Unknown versions, unknown
fields, invalid layouts and files that would exceed the size limit are refused
without replacement. A stale editor revision is rejected after migration; reload
before saving. Read-only inspectors and unopened boards do not initiate migration.

Saved historical inputs, providers and recovery IDs remain unchanged even if
the node now selects the plugin. After cutover, a built-in MiniMax task cannot
be retried: it has no durable vendor task ID. Plugin removal or disablement
does not reverse already migrated selections.

### MiniMax project video defaults

The same committed startup migration enables project default migration. Owning
project loads, settings refreshes, folder registration, archive imports, copies
and subsequent saves map known legacy MiniMax video defaults to the plugin.
Other media defaults and unrecognized model identities stay unchanged. Pending
settings for an unavailable workspace migrate in the local project record and
move into the folder when it returns. Clearing a default remains cleared.

Portable settings and local records retain unknown fields; unreadable or newer
settings and linked files are not replaced. Refreshes and edits share the
project metadata queue. Migration preserves the project's modification time
and does not rewrite job inputs, recovery IDs or canvas history. Read-only
folder discovery does not initiate migration. Project default migration never
transfers ownership of unfinished generation tasks.

### Seedance saved selections and defaults

After the verified Seedance settings transaction commits, owning board and
project loads map reviewed Ark image/video and BytePlus video selections to
`plugin.ohmygame.seedance.ark` / `plugin.ohmygame.seedance.byteplus`. Mapping checks
both the region and media kind; an image ID in a video selection, an unsupported
model or an unrelated provider remains unchanged. MiniMax and Seedance activation
states are independent.

The same [canvas ownership and preservation rules](#minimax-saved-canvas-selections)
and [project default lifecycle](#minimax-project-video-defaults) apply, now to both
image and video defaults. Missing workspace folders, imports, copies, refreshes,
concurrent edits and explicitly cleared choices retain their existing behavior.
Unrecognized stored fields are preserved where the store supports them; a board
or settings file that fails its full validation is refused without rewriting it.
Existing outputs, task inputs, recovery IDs and history never change owner.
Historical task retries follow the [committed-profile cutover](#seedance-committed-profile-cutover).

### MiniMax committed-profile cutover

A profile with committed settings migration uses the Beta plugin for MiniMax.
The built-in connection and models no longer appear, and their credential
endpoints refuse changes. Original credentials remain on disk. An explicit
request to the old provider is rejected instead of falling back or silently
starting a request with a different owner. Profiles whose migration is deferred
continue using the built-in provider until the verified plugin is ready.

Old built-in MiniMax jobs retain their input and recovery identity. Retrying a
failed or cancelled job is refused before replacing its record or contacting a
vendor. Job lists explain this in the selected UI language while retaining the
original error in stored history. Check that task in MiniMax before intentionally starting a new generation
with the plugin; the old integration did not retain a vendor task ID, so it cannot
safely resume it. The migration never automatically resubmits a task. Plugin jobs
continue to use their own persisted recovery journal. Disabling or uninstalling
the plugin does not reactivate the retired built-in provider.


### Seedance committed-profile cutover

After the reviewed settings transaction commits, built-in Ark / BytePlus
connections and Seedream / Seedance models disappear from settings and catalogs.
Explicit requests to old model identities and old key update/removal routes are
refused. Retained source credentials never become a fallback when the plugin is
disabled, removed or unavailable. Unmigrated profiles retain their existing paths.
Custom providers using the same protocols keep their separate identities.

Historical built-in image and video jobs keep their original inputs, outputs,
errors and recovery IDs. Old video requests have no durable vendor task ID;
old image requests cannot retrieve a lost synchronous result. Neither can be
safely replayed as plugin work. Failed or cancelled jobs show a localized notice
and reject direct retry before starting a request. Check results and billing in
Ark or BytePlus before deliberately starting a new generation. Plugin-owned
video tasks retain their own journals and recovery behavior.

The user has verified Ark and BytePlus generation and restart recovery. Automated
cutover checks use simulated providers and published packages without vendor
requests or changes to a live user profile. Legacy code stays within the stated
compatibility window for profiles whose migration has not committed.

### 3D Beta package preparation

Meshy `@ohmygame/meshy@0.1.1` and Tripo `@ohmygame/tripo@0.1.0` are
optional Beta packages requiring API 2.16. Their exact npm SHA-512 values and
indexed package digests are pinned in `src/daemon/model3d-migration-package.ts`.
Preparation verifies the archives into `.runtime/meshy-migration-packages/` and
`.runtime/tripo-migration-packages/` for integration tests. These fixtures are
not shipped or added to the preinstalled index.

The read-only package preflight requires one reviewed, managed npm package,
matching actual bytes and index metadata, complete permissions, and explicit
every-project enablement. It never installs, enables or changes settings.
Hyper3D has no reviewed migration package yet.

Startup rolls back any interrupted Meshy, Tripo or Hyper3D settings transaction
before MiniMax or Seedance can write the shared plugin configuration or model
preferences. This also runs in safe mode and does not depend on a plugin being
installed or approved. Corrupt/conflicting recovery records stop startup before
new migration writes; committed backups remain untouched. This recovery step
does not activate a 3D migration.

Native 3D services remain active. The prepared settings, canvas/project reference
and historical task recovery paths must activate together; each vendor needs
real generation and restart acceptance before cutover.
Existing native task journals must retain their original provider and paid
stage IDs, even after new requests move to a plugin. Free-cloud Hyper3D is
independent from the own-key connection.

The native journal's optional `requireExistingStage` mode prepares recovery-only
execution: its first requested stage must already exist, match the connection and
input fingerprint, and have confirmed task credentials. Empty, absent or unrelated
records cannot start a new submission. After that confirmation, later stages such
as refinement may submit once through the same durable journal; an uncertain
submission still blocks retry. This gate shares the existing submission lock and
can wait for an original in-flight request. It does not itself select a provider,
authorize credentials or activate native retirement; startup and retry routing
must establish those separately.

#### Rehearse 3D settings migration

After `bun run prepare:preinstalled-plugins`, close the app and copy its data
directory to a private folder. Rehearse one provider at a time:

```bash
bun run rehearse:3d-migration --provider meshy --data-dir /absolute/path/to/copied-app-data
bun run rehearse:3d-migration --provider tripo --data-dir /absolute/path/to/copied-app-data
```

The command uses the reviewed package fixture and changes only a temporary
settings copy. It checks the legacy key, plugin configuration, provider
visibility/defaults, and plugin model choices through their owning stores.
Native custom versions and preset overrides become plugin model definitions;
Meshy image mode and topology, model names, face-count presets/defaults, texture
and PBR defaults are retained. Hidden IDs (including absent versions), disabled
providers, default-reference metadata and unrelated extension fields are kept.
Existing matching target definitions retain their adapter data and metadata.
Conflicting keys, model definitions or visibility choices hold the whole proposal;
unreadable/newer stores and unsupported native model fields are not overwritten.

The report contains fixed reason codes and counts, never keys, arbitrary model
names or parser details. It verifies reload, idempotency and byte-exact rollback,
then removes the temporary copy and checks that the supplied files are unchanged.
There is no `--apply` option, startup hook, plugin installation, permission change
or vendor request. Real package/enablement checks, local vendor acceptance,
saved-reference migration and native task recovery remain required before cutover.

The rehearsal also includes `.<provider>-model-references-v1.json` in the same
transaction as settings. This versioned record contains the reviewed
package identity/digest, generation IDs (including native custom versions), their
operations, the processing connection and the effective native model settings for
recovery. It contains no keys or model display names. Unsupported or conflicting existing
records block the entire proposal. Interrupted, uncommitted transactions restore
both settings and the record byte for byte.

The prepared transaction API reads reference state only from the checksummed,
committed backup, never from the editable sidecar or today's model catalog.
Deleting models, clearing a key or uninstalling a plugin cannot undo that recorded
migration; invalid backups are refused instead of interpreted as native ownership.
Historical package identity does not grant execution permission: future startup
activation must still check the installed package and current plugin enablement,
and native task recovery must use current credentials. These startup and retry
paths are not activated by the rehearsal.

#### Prepared 3D reference migration

The shared migration state accepts reviewed per-provider model IDs, generation
operations and processing connections after a settings transaction commits.
Startup does not supply this 3D state yet; activation remains held for real vendor
acceptance and the production startup wiring.

With that committed state, project 3D defaults and future canvas selections move
to the matching plugin. Known custom versions retain their IDs. Generation nodes
map only supported text/image selections; unknown IDs stay unchanged. Remesh,
retexture and animation nodes map old native geometry IDs to the plugin processing
connection, matching the native resolver's existing behavior. An animation node
without an explicit model retains its implicit Meshy connection when Meshy moves;
a Tripo-only migration does not change that default.

Canvas loads reuse the existing validation, lock, size limit and conflict checks;
saves normalize old client references too. Options, prompts, action order, sources,
outputs and layout remain intact. Project metadata keeps unrelated fields, while
unsupported board data is refused unchanged. Job inputs, recovery IDs and native
paid-stage journals are never mapped by this step, and their retry routing remains
a separate cutover requirement.

#### Native task recovery preparation

`NativeModel3DRecovery` can route saved tool and canvas jobs through the original
native adapter, independently of the current public model catalog. It loads the
effective generation and processing settings sealed by the migration, including
custom versions. It never rebases those settings onto newer presets or uses later
model edits. Older identity-only preparation records remain readable for reference
mapping, but recovery refuses them rather than inventing the missing settings.

The prepared application context checks the current reviewed npm package,
every-project enablement, capability grants, provider switch and plugin secret.
Each native HTTP request checks authorization again and refuses a changed key.
Requests and downloads must use HTTPS on the plugin's approved hosts, without
URL credentials; automatic redirects are refused so they cannot bypass that grant.
Clearing the key, disabling the plugin/provider, revoking its grants or uninstalling
it does not fall back to the retained native key. A key or original input that
already changed before migration still fails the saved request fingerprint.

The recovery adapter owns a journal in `tools/model3d-tasks` with the existing-stage
gate. Standalone retries and canvas retries retain their saved inputs and recovery
IDs even after future canvas selections move to a plugin. Implicit historical
Meshy animation keeps its original owner; later stages can continue only after
the first saved stage is confirmed. New plugin submissions never consume these
native receipts. A host refusal before dispatch removes only that unsubmitted
stage's marker, so restoring authorization can continue. Once dispatch starts,
transport failures remain ambiguous and never automatically resubmit a paid task.
No recovery adapter is exposed as a selectable model.

The prepared application context below consumes these recovery records together
with native retirement and future-reference mapping. Production startup activation
and vendor acceptance remain held. Recovery tests use simulated vendor responses.

#### Settings activation preparation

`migrateModel3DSettings` prepares the exclusive per-provider activation boundary.
It first restores any uncommitted attempt, then verifies the reviewed managed npm
package and grants before proposing settings, reference mappings and original
recovery parameters together. After applying, it reloads the owning stores,
requires an idempotent proposal and checks package permissions again before
sealing the commit. A failed validation rolls back the settings; it never undoes
a separately revoked grant.

A current plugin key can support migration even if the original native key was
already cleared. If both keys are absent, no migration is committed. Conflicting
keys, unreadable settings and safe mode defer new activation. An existing sealed
commit remains authoritative after key resets, uninstall or safe-mode restart;
those actions cannot silently revive the native provider.

Production startup does not call this entry point yet. Its caller must own the
profile, recover all other provider transactions first, and construct model,
reference and task-recovery consumers from the committed result. Real vendor
acceptance and production startup wiring are still required before cutover.

#### Prepared application ownership

The internal `model3DMigrations` application context is a cloned set of committed
records. The same records retire the native catalog/settings entries, migrate
project and future canvas selections, and authorize recovery of existing paid
tasks. Retired native settings routes return a translated conflict response and
cannot modify the retained native keys or model definitions. The own-key Hyper3D
migration first preserves both old effective switch states in the settings proposal,
then separates their controls so free-cloud changes cannot revive native access.

New standalone or canvas requests map reviewed native model IDs to the plugin.
Implicit new Meshy animation and its action catalog use the migrated processing
connection. Prepared retries keep their original native inputs and receipt IDs;
they are never rewritten as new plugin submissions. The standalone HTTP job
schema preserves 3D operation, source asset and advanced options, with their
strict operation-specific validation still owned by ToolRunner.

Production startup still supplies no 3D migration contexts. This is tested
application preparation; vendor acceptance and startup activation remain held.

### Prepared ElevenLabs model references

A dormant `elevenlabs` migration flag maps the six reviewed generation model
identities only after a settings commit. It covers project speech, sound-effect
and music defaults, audio canvas selections and fresh tool inputs before model
resolution. Voice, speed, language, assets and unknown reference metadata stay
unchanged. Scribe, unknown models and mismatched audio kinds are not remapped.

Historical native audio jobs retain their original input and output ownership.
After activation, retrying an unfinished native job is refused with a translated
notice to check ElevenLabs results and billing first: the native synchronous
request has no durable receipt that could safely resume through the plugin.
The notice does not overwrite stored history. Startup does not enable this flag
until the published package, settings transaction and local acceptance are ready.
Compatibility removal: no earlier than beta.7 and 2026-12-15, after retained
native job obligations are resolved.

### Prepared ElevenLabs startup transaction

The dormant `migrateElevenLabsSettings` entry point composes the reviewed-package
gate, read-only inspector and guarded settings transaction. It requires exclusive
profile ownership before any settings consumers are constructed. A first commit
copies compatible settings once; later calls honor the committed receipt rather
than restoring credentials the user subsequently removes. Safe mode, conflicts,
unknown data, missing grants and modified packages defer without settings writes.

Startup recovers any interrupted ElevenLabs transaction before MiniMax or
Seedance can write shared configuration/preferences, including in safe mode.
It does not start a new ElevenLabs migration. Production activation, native
catalog retirement and reference remapping remain held for local acceptance.
Native files and paid task ownership remain unchanged. Remove this compatibility
path no earlier than beta.7 and 2026-12-15 after retained obligations are resolved.

### Prepared ElevenLabs application context

The internal `elevenlabsSettingsMigrated` option is supplied only after a validated
settings commit. It retires the native catalog and credential/settings routes,
activates project/canvas/future tool reference mapping, and refuses historical
native retries. The same state makes stale global default selections resolve to
reviewed plugin identities. Unmigrated profiles keep their native provider.
Native credential files remain untouched and are no longer loaded after commit.

The actual installed Beta adapter supplies account voices and transcription as
well as generation. Disabling or removing it cannot re-enable native fallback.
Production startup still leaves this context unset pending local acceptance;
this is application preparation, not an automatic provider switch.

### Doubao Beta package verification

`@ohmygame/doubao-voice@0.1.0` was published from
[official plugins #26](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/26).
The npm registry signature (with a key valid at verification), tarball SHA-512,
all nine packaged files against reviewed source, and the host package digest
were verified. The package requires API 2.25 and declares `beta: true`. Its market
record, index checksum and served logo match the actual release. The workflow
published provenance; local verification checks the registry signature, not the
SLSA bundle itself.

`DOUBAO_MIGRATION_PACKAGES` pins those published bytes for disposable integration
fixtures. It does not add a preinstalled plugin. The read-only package gate
requires a matching managed npm installation, current verified index metadata
and existing app-wide permission grants. Changed files, unreviewed versions,
disabled/project-only installs and missing grants hold migration; the gate does
not install, enable, grant or write settings. The two native audio services remain
available pending real-account acceptance and the remaining migration work.

### Doubao / Volcengine settings inspection

The optional `ohmygame/doubao-voice` Beta combines speech synthesis and Seed Audio
under one API key and requires host API 2.25. Native services remain available.

```sh
bun run inspect:doubao-migration --data-dir /path/to/copied-app-data
```

This reads only `doubao-voice.json`, the two earlier `volcengine-tts.json` and
`volcengine-seed-audio.json` files, plugin configuration and model preferences.
It deliberately does not load the native settings store, whose loader merges
and removes the earlier files. Current service overrides, including an explicit
`null` disconnection, take precedence over earlier keys. The current default
voice takes precedence; an absent one can use the earlier TTS default. The
inspector preserves every file byte, checks for concurrent changes, and refuses
linked files/directories.

Equal effective service keys can be proposed for the shared plugin field.
Different keys or only one connected service hold migration: combining them
would replace a key or reconnect a service. The current `volcengine-tts` provider
owns both models. Its switch and hidden
models transfer together; conflicting explicit choices under the historical
`volcengine-seed-audio` provider hold migration. Unknown models,
conflicting target choices, invalid voice types, future/malformed stores and
unknown legacy fields require review. Defaults must match both their original
provider's model and audio kind. Credentials, voice IDs, unknown data and parser
input never appear in the report.

Exit codes are 0 for no settings blockers, 1 for blockers and 2 for invalid
arguments, unavailable/linked data or a changing snapshot. Even a clear report
remains `activation: "held"`: this command does not install or enable a plugin,
copy settings, verify live generation, rewrite canvas references or replay old
paid requests. Native unfinished audio still owns its original request; a
settings proposal cannot turn it into an automatic plugin resubmission.

### Doubao settings rehearsal

```sh
bun run rehearse:doubao-migration --data-dir /path/to/copied-app-data
```

The rehearsal copies only the five inspected settings files into a private
throwaway directory. After preflight, it proposes the shared key and default
voice, combines known hidden models and matching provider switches, and maps
speech/effect/music defaults while preserving unknown target metadata. It
applies only to the copy, reloads it, checks that repeating the proposal changes
nothing, then rolls back to the original bytes and removes the copy. Blocked
settings never reach the transaction; the input directory is never written.
Reports contain only fixed reasons, counts and verification booleans.

The separate Doubao journal keeps all three native credential files immutable,
including absent legacy files. Both proposal validation and recovery reject a
journal that changes any of them. Original bytes stay in a committed backup;
uncommitted recovery rolls back target configuration/preferences before a
future settings consumer may load them. The shared transaction engine now takes
an explicit list of immutable sources; existing provider receipt formats and
recovery paths are unchanged. Production startup does not activate this Doubao
transaction yet. Real-account acceptance, installed-package gating, reference
mapping and native paid-request ownership remain separate cutover requirements.

### Prepared Doubao model references

A dormant `doubao` migration flag maps both current audio models under
`volcengine-tts`, plus the historical `volcengine-seed-audio` Seed Audio reference,
to `plugin.ohmygame.doubao-voice.doubao-voice`. Mapping checks the model and audio
kind, retains voice/output options and reference metadata, and changes only
future selections in project defaults, canvas boards and new tool requests.
Unknown models and incompatible kinds remain visible to normal validation.

Old speech/effect/music nodes using the separate Seed Audio provider receive
kind-specific prompt instructions during their existing audio-format migration.
Provider mapping preserves those instructions before changing the ID, so opening
an old music node still requests instrumental music. Raw nodes and output
provenance remain otherwise unchanged; repeated loads are idempotent. Unknown
board data is refused without overwriting it.

Historical native paid jobs retain their owner and original stored request/error.
After activation, failed/cancelled jobs show a translated notice to check the
Volcengine result and billing; retry is refused before generation. Native audio
has no durable vendor receipt that a plugin can safely resume. Production
startup does not set this flag yet. Remove compatibility no earlier than beta.7
and 2026-12-15, after retained native-task obligations are resolved.

### Prepared Doubao activation and startup recovery

The dormant `migrateDoubaoSettings` coordinator requires the exact reviewed
Beta package, its existing enabled grants, and a conflict-free proposal. It
supports the current shared settings and profiles containing only the two old
service files. It copies credentials, the default voice and compatible model
preferences in one recoverable transaction; all three native source files remain
byte-for-byte unchanged. A durable commit prevents a later startup from restoring
credentials the user removed from the plugin.

Startup recovers an interrupted Doubao transaction before any new shared settings
migration, including in safe mode. An invalid receipt stops startup before those
writes. Production does not begin a new Doubao migration yet: real-account
acceptance and application ownership remain separate cutover requirements.

### Prepared Doubao application ownership

After a validated commit, the dormant `doubaoSettingsMigrated` application option
coordinates catalogs, provider summaries, saved references, fresh requests and
native settings routes. Both old provider IDs are retired, including the speech
preview and default-voice update endpoints. The retained native settings are not
loaded or changed; malformed legacy files cannot trigger a native merge after
ownership has moved to the plugin. Removing or disabling the plugin leaves it
unavailable instead of reviving the native connection.

The installed Beta owns new TTS and Seed Audio work, with its migrated default
voice, output settings and durable request receipts. Native historical paid work
is never resubmitted automatically. Production startup still leaves the option
unset pending real-account acceptance; this is preparation, not cutover.
