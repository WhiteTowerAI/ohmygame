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

### Seedream / Seedance beta and settings inspection

`@ohmygame/seedance@0.1.0` is an optional Beta published from
[official plugins #20](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/20).
It requires plugin API 2.8 and provides three Seedream image models and four
Seedance video models. Its npm signature, integrity, packaged files and market
entry have been verified. Live generation and restart acceptance remains a
separate step before switching existing built-in providers.

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

### Optional MiniMax beta artifact

The reviewed migration targets are `@ohmygame/minimax@0.1.0`, `0.1.1` and `0.1.2`,
published from [official plugins #17](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/17),
[#18](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/18) and
[#19](https://github.com/WhiteTowerAI/ohmygame-plugins/pull/19). Version `0.1.1`
updates the English/Chinese migration guidance. Version `0.1.2` requires API
`^2.8.0` and documents retained task ownership after local stop or query/download
failure. The adapter, models and grants are unchanged across all three releases.
Exact npm SHA-512 integrity and indexed package digests are pinned in
`src/daemon/minimax-migration-package.ts`.

All three published artifacts passed npm signature and integrity checks and the
app's plugin validator; their packaged files match the tested source. They declare
`beta: true`; `0.1.0`/`0.1.1` remain compatible with API `^2.7.0`. Each provides
regional `cn`/`global` video providers using `cnApiKey`/`globalApiKey`, with
`MiniMax-H3` and `MiniMax-H3-Max` models. They remain optional and outside the
preinstalled lock.

Live generation, downloading and quit/reopen recovery acceptance has passed for
the adapter shared by these releases. For subsequent adapter changes, repeat the
[plugin's local test instructions](https://github.com/WhiteTowerAI/ohmygame-plugins/blob/main/plugins/minimax/README.md#local-testing--本地测试).
Startup checks the single active installed version against its reviewed package;
another release or ambiguous index defers migration. Build preparation verifies
each archive into `.runtime/minimax-migration-packages/<version>/source` and tests
startup migration and recovery against each release. These disposable fixtures
are not added to the preinstalled index.

### MiniMax startup settings migration

After profile ownership and recovery, before constructing the app, startup can
migrate legacy MiniMax settings to an **already installed and enabled** optional
`0.1.0`, `0.1.1` or `0.1.2` plugin. It reindexes the managed package files and compares their digest
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

MiniMax is available as the optional `@ohmygame/minimax@0.1.2` beta (OhMyGame
API 2.8). Publication alone does not enable migration or replace the built-in
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

