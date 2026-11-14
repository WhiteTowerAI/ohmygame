# Media provider plugins

Plugin API 2.5.0. Built: the sandbox, `host.fetch`, images, videos, audio
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
- **3D** models (`media["3d"].models`) say the `operations` they make from
  (`text`, a prompt; `image`, pictures of the object), how many pictures they
  take (`maxReferenceImages`, 1 when left out), their `polycount` range and
  default, with the `presets` the canvas offers, and whether they `texture`
  the model and make `pbr` materials.
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
  (10 minutes for an image) while the vendor holds a task.

`input` is what OhMyGame asks for. It is fixed per kind and versioned with the
plugin API. Every kind's input also has `modelData` when the model has
`data`. A JavaScript section is named as the kind, so 3D is
`export default { "3d": { start, check } }`.

- **Image:** `model`, `prompt`, `resolution` and `aspectRatio` (one of the
  model's, after a legacy size is matched to them), `transparentBackground`
  when the asset needs one, and `references` (`[{ mediaType, base64 }]`).
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
  These lists may differ: a provider can offer only `adaptive` for frames
  while requiring a concrete text-to-video ratio. The picker and request
  validation use the same rule, including discovered models saved in Settings.
- **Audio:** `model`, `kind` (one of the model's), `prompt` (the words for a
  model that reads text, a description for the rest), `format` (one of the
  model's), `voiceId` for a model that reads text (one of its `voices`, the
  first by default), and when asked and the model takes them,
  `durationSeconds`, `instrumental`, `loop` and `language`. Speech can carry
  `speed`, from -50 (half as fast) to 100 (twice as fast), 0 when left out.
- **3D:** `model`, `operation` (`text` or `image`), `prompt` for `text`,
  `references` (`[{ mediaType, base64 }]`, the first the front) for `image`,
  `targetPolycount` (in the model's range), and `texture` and `pbr`, each
  false unless the model offers it and it is asked for.

`outputs` are `{ url }`, which the app downloads without the key, or
`{ base64, mediaType }`. A `url` must be on a `capabilities.network` host too,
so list the host the vendor's results are on (SiliconFlow's are on
`sc-maas.oss-cn-shanghai.aliyuncs.com`); a download elsewhere fails with the
host's name. The app checks what it got (an image must be PNG, JPEG or WebP,
a video MP4 of at most 500 MB, audio a playable file of the format the
person picked, or when they picked none, any of MP3, WAV and Ogg Opus, since
some vendors don't say which file a model makes, and a 3D model a binary glTF (GLB) of at most 100 MB) and writes it to the
project, as a built-in provider's result is. A request takes the first output.

`host` holds:

- **`host.fetch(url, init)`**: HTTPS to the plugin's `capabilities.network`
  hosts only.
  - `auth: true` adds the key as `media.auth` says. `json` sends a JSON body.
    Where the answer to such a request repeats the key, in a header or the
    body, the adapter reads `[key]` instead.
  - The answer gives `status`, `ok`, a few headers (`content-type`,
    `content-length`, `retry-after`, `location`, `x-request-id`), and `json()`
    or `text()` of at most 20 MB, so a picture sent back as base64 fits.
  - Redirects aren't followed, and cookies aren't kept.
  - This is the same rule as a project panel's `net.fetch`.
- **`host.log(message)`**: writes to the plugin's log.

### The sandbox

The adapter runs in QuickJS compiled to WebAssembly (`quickjs-wasi`, MIT,
which the agent runtime already ships), inside the daemon:

- each call gets 64 MB of memory and 2 seconds of its own CPU time (waiting on
  `host.fetch` doesn't count), and 2 minutes in all;
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
same way. A file the app can't read is never written over.

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
- When the person stops a generation, a step fails, or time runs out, the app
  calls `cancel` and forgets the task: a retry starts afresh.
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
7. Later: 3D retexture, remesh and animation, transcription, and voices
   listed from the vendor's account; then moving the built-in media providers
   (Seedance, MiniMax, Meshy, Tripo, Doubao) to official plugins, with their
   saved keys moved to the plugin's settings.


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

### MiniMax settings inspection (preparation only)

MiniMax remains private and unpublished pending live generation and restart
acceptance. To inspect migration inputs, close the app and copy its data directory
to a private local folder, then run from this repository:

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
- All `media-tasks/*.json` in the selected app data are counted as unconfirmed,
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

Before enabling migration in the app, complete these separate gates:

- Verify real generation, result download, stop and restart recovery in both
  regions with the optional adapter. Retrying a recovered request must not start
  a second paid generation. Local stop does not imply vendor cancellation.
- Obtain publication authorization, publish the accepted package, pin its
  integrity, and verify the installed package's provider/model contract. The
  inspection's mapping is a preparation snapshot, not a package lock.
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
