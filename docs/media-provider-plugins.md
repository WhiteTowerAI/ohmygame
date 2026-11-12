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
          "aspectRatios": ["1:1", "16:9", "9:16"], "maxReferenceImages": 1, "maxOutputs": 4 }] },
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
  word (`readsText`) and in which `voices`, the `formats` they make (`mp3`,
  `wav`, `ogg_opus`; `mp3` when left out), and the limits they take:
  `maxTextCharacters`, `minDurationSeconds`, `maxDurationSeconds`,
  `instrumental` and `loop`.
- **3D** models (`media["3d"].models`) say the `operations` they make from
  (`text`, a prompt; `image`, pictures of the object), how many pictures they
  take (`maxReferenceImages`, 1 when left out), their `polycount` range and
  default, with the `presets` the canvas offers, and whether they `texture`
  the model and make `pbr` materials.
- `audio` and `3d` take `maxMinutes` as `video` does (10 and 15 minutes when
  left out).
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
        json: { model: input.model, prompt: input.prompt, image_size: size(input.aspectRatio), batch_size: input.count },
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
plugin API. A JavaScript section is named as the kind, so 3D is
`export default { "3d": { start, check } }`.

- **Image:** `model`, `prompt`, `resolution` and `aspectRatio` (one of the
  model's, after a legacy size is matched to them), `transparentBackground`
  when the asset needs one, and `references` (`[{ mediaType, base64 }]`).
- **Video:** `model`, `prompt`, `duration` (seconds), `resolution` and
  `aspectRatio` (one of the model's each), `references` (`[{ mediaType,
  base64 }]`, pictures only), and `referenceMode` when there are references:
  `frame` (the first, and the last if there are two) or `reference` (a look
  to follow). A model's `referenceModes` lists the modes it takes, `frame`
  when it leaves them out.
- **Audio:** `model`, `kind` (one of the model's), `prompt` (the words for a
  model that reads text, a description for the rest), `format` (one of the
  model's), `voiceId` for a model that reads text (one of its `voices`, the
  first by default), and when asked and the model takes them,
  `durationSeconds`, `instrumental`, `loop` and `language`.
- **3D:** `model`, `operation` (`text` or `image`), `prompt` for `text`,
  `references` (`[{ mediaType, base64 }]`, the first the front) for `image`,
  `targetPolycount` (in the model's range), and `texture` and `pbr`, each
  false unless the model offers it and it is asked for.

`outputs` are `{ url }`, which the app downloads without the key, or
`{ base64, mediaType }`. A `url` must be on a `capabilities.network` host too,
so list the host the vendor's results are on (SiliconFlow's are on
`sc-maas.oss-cn-shanghai.aliyuncs.com`); a download elsewhere fails with the
host's name. The app checks what it got (an image must be PNG, JPEG or WebP,
a video MP4 of at most 500 MB, audio a playable file of the format asked for,
and a 3D model a binary glTF (GLB) of at most 100 MB) and writes it to the
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

A video's or a 3D model's task survives a restart, as a built-in 3D job's
does (`model3d-journal.ts`).
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
ended with them. Images and audio, which rarely take a task, start again.

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
  on its page, its models of each kind.

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
5. Later: 3D retexture, remesh and animation, transcription, and voices
   listed from the vendor's account; then moving the built-in media providers
   (Seedance, MiniMax, Meshy, Tripo, Doubao) to official plugins, with their
   saved keys moved to the plugin's settings.
