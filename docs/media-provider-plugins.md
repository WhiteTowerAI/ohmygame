# Media provider plugins (design)

Status: proposed for plugin API 2.5.0. Nothing here is built yet.

A plugin's model provider can make images and videos, not only chat. The
vendor's API, which differs from vendor to vendor and changes often, is the
plugin's to translate, so a change there ships as a plugin update, not an
OhMyGame release. OhMyGame changes only when it wants something new from
every provider, such as a first and last frame for video.

Audio and 3D follow the same contract later, once the built-in providers
behind them (#649) move onto it.

## What stays the same

- A provider is one entry in `contributes.providers`, one row in Settings →
  Providers and on the plugin's page, with one key. A vendor that serves chat,
  images and video is one provider, not three.
- Its key is a `secret` setting the app reads. The plugin's code never sees it.
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
        "video": { "models": [{ "id": "Wan-AI/Wan2.2-T2V-A14B", "title": "Wan 2.2",
          "durations": [5], "resolutions": ["720p"], "aspectRatios": ["16:9"],
          "maxReferenceImages": 1, "referenceModes": ["frame"] }] }
      }
    }]
  }
}
```

- `api` and `baseUrl` become optional, so a provider can make media only.
  It needs at least one of chat (`api`, `baseUrl`) and `media`.
- `media.adapter` is a JavaScript file in the package (at most 512 KB).
- `media.auth` says how the app adds the key to a request the adapter marks
  `auth: true`. It can be a header with an optional scheme (`Bearer`), or a
  query parameter. Signing a request with the key, as Volcengine's API does,
  is left for later; such vendors stay built in until then.
- Each kind lists its models and what they take. These are the fields the app
  already uses for custom image and video models, so pickers, the canvas and
  the agent's tools work unchanged.
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
- **`cancel(task, host)`** is optional. It is called when the person or the
  agent stops the work.

`input` is what OhMyGame asks for. It is fixed per kind and versioned with the
plugin API:

- **Image:** model, prompt, aspect ratio or size, count, and reference images
  (`{ mediaType, base64 }`).
- **Video:** model, prompt, duration, resolution, aspect ratio, reference
  mode (`frame` or `reference`), and the reference images.

`outputs` are `{ url }`, which the app downloads, or `{ base64, mediaType }`.
The app checks what it got and writes it to the project, as a built-in
provider's result is.

`host` holds:

- **`host.fetch(url, init)`**: HTTPS to the plugin's `capabilities.network`
  hosts only.
  - `auth: true` adds the key as `media.auth` says. `json` sends a JSON body.
  - The answer gives `status`, `ok`, a few headers (`content-type`,
    `retry-after`, `location`), and `json()` or `text()` of at most 5 MB.
  - Redirects aren't followed, and cookies aren't kept.
  - This is the same rule as a project panel's `net.fetch`.
- **`host.log(message)`**: writes to the plugin's log.

### The sandbox

The adapter runs in QuickJS compiled to WebAssembly (`quickjs-wasi`, MIT,
which the agent runtime already ships), inside the daemon:

- each call gets 32 MB of memory and 2 seconds of its own CPU time (waiting on
  `host.fetch` doesn't count);
- there is no `fetch`, `require`, `process`, file system or clock beyond
  `Date`;
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
- Checks run only while a task is running, and the whole task gives up after
  the kind's limit (video: 15 minutes, as now).
- Webhooks aren't used. A desktop app has no public address for a vendor to
  call, and a relay of our own would cost money and see people's prompts.
  Streaming answers (`text/event-stream`) can be added to `host.fetch` when a
  vendor needs them.

A task survives a restart. The app stores the task value with the request,
as it does for 3D jobs (`model3d-journal.ts`), and checks it again when the
daemon starts. A paid `start` is never repeated for the same request.

## In the app

- `PluginMediaProviders` (`src/daemon/plugin-media-providers.ts`) reads
  installed plugins' media sections. It adds their models to the image and
  video catalogs under the provider's id (`plugin.<publisher>.<name>.<id>`),
  only while the key is set and the provider is on.
- Image and video requests for those models go to the adapter through the
  sandbox. Everything after the result (checking it, saving it, the Library,
  undo) is shared with built-in providers.
- The provider's page in Settings and on the plugin's page lists its models
  under **Chat**, **Images** and **Videos**.

## Market

The index adds each plugin's `providerKinds` (`language`, `image`, `video`,
and later `audio`, `3d`), taken from its manifest. Under **Model providers**,
Discover shows a second row of chips for the kinds something is in, and each
card shows small tags for its kinds. The author doesn't write these
separately: they are the kinds the provider has to implement anyway, so a tag
can't promise what the plugin doesn't do.

## Order of work

1. The sandbox, `host.fetch`, and image `start`. This includes the official
   SiliconFlow plugin's images, end to end.
2. Video, with tasks, `check`, `cancel`, `retryAfter`, and resuming after a
   restart.
3. The market's kinds: the index field, the chips under Model providers, and
   the tags on cards.
4. Later: audio and 3D, then moving the built-in media providers (Seedance,
   MiniMax, Meshy, Tripo, Doubao) to official plugins, with their saved keys
   moved to the plugin's settings.
