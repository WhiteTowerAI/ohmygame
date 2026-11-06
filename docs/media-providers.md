# Media providers

The image, video, 3D and audio connections that take a person's own API key
are listed once, in `src/daemon/providers/built-in.ts`. Each row names the
provider (`id`, display `name`, `capabilities`), says how to tell whether it
is configured and how to forget its key, and hands over the audio adapter it
contributes. `MediaProviderRegistry` in `src/daemon/providers/registry.ts`
turns that list into what the rest of the daemon reads:

- `GET /settings/providers` lists every row with the same summary shape:
  `configured`, `enabled`, `status`, `capabilities` and an `api_key` method.
- `DELETE /settings/models/providers/:id` clears the row's key through the
  registry, alongside the provider's model preferences.
- `ProviderAudio` takes the rows' audio adapters in listing order, which is
  the order of the audio catalog.

The settings stores and their files are unchanged: `meshy.json`, `tripo.json`
and `hyper3d.json` through `MediaProviderKeyStore`, `seedance.json`,
`minimax.json` and `doubao-voice.json` through their own stores. The settings
routes under `/settings/models/providers/...` stay per family, so adding a
built-in provider still means a store and routes for it, plus one row in the
list for its summary, removal and adapters. The registry is internal to the
daemon; how plugins will contribute providers is decided with the plugin
system, see issue #671.
