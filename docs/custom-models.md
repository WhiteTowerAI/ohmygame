# Custom providers and models

In **Providers & Models**, choose **Add provider**, enter a name, Base URL and
authentication, and select a service preset if one fits your endpoint. Presets
provide connection defaults; each model can use its own generation protocol.
The default language protocol also determines how the general model list is fetched.
Custom provider names must be unique, ignoring case and surrounding spaces.
Existing duplicate names remain usable while you rename them.

Choose **Fetch** to load the complete model list, or **Add a model manually** to
enter a model ID that the endpoint does not list. Model discovery is optional;
services such as Meshy, Tripo and Hyper3D may require manual IDs. Their official connections
offer **Load presets** instead of requesting a language `/models` endpoint. This
loads documented starter definitions and does not check key access. Compatible
custom relays can still fetch their own model lists. Discovery never generates media.

Newly fetched models start disabled. Edit a model and choose one or more uses:
**Language**, **Image**, **Video**, or **3D**, then enable it. The same model ID can
serve several uses. Unknown models remain **Unassigned** until you configure them.
**Enable all configured models** skips unassigned models.

Provider metadata and known model templates may suggest uses and limits. Check
them against your endpoint's documentation. Refreshing the list preserves saved
names, uses, protocols, limits and enable state, including models no longer listed
by the endpoint. Remove those models explicitly if you no longer want them.

## Protocol templates

| Use | Protocol | Endpoint format |
| --- | --- | --- |
| Language | OpenAI Chat Completions / Responses, Anthropic, Google | Existing language adapters |
| Image | OpenAI Images | `/images/generations`, or multipart `/images/edits` with references |
| Image | Gemini Generate Content | `/v1beta/models/{id}:generateContent` |
| Image | OpenRouter Images | `/images` |
| Image | Seedream | `/images/generations` with Seedream JSON parameters |
| Video | OpenRouter Videos | `/videos`, task polling and output download |
| Video | Seedance | `/contents/generations/tasks`, task polling and output download |
| 3D | Meshy | `/image-to-3d` or `/multi-image-to-3d`, task polling and GLB download |
| 3D | Tripo V3 | `/files`, `/generation/image-to-model` or `/generation/multiview-to-model`, `/tasks/{id}` and GLB download |
| 3D | Hyper3D Rodin | multipart `/rodin`, `/status`, `/download` and GLB download |

Custom models use the exact model ID you save, including gateway aliases. The
endpoint must implement the selected protocol and accept that ID. A matching name
is not required. Each use has an optional Base URL override; leave it blank to
share the provider's connection and credential.

The Gemini preset uses Google's API-key header. Gemini image models reached
through an OpenAI-compatible relay use bearer authentication. Services with
**No API key** receive generation requests without an authorization header.

## Generation settings

Image settings include resolutions, aspect ratios, reference-image limits and
output count. The application accepts up to 14 image references. Video settings
include resolutions, ratios, durations (1–30 seconds), reference-image limits
(up to 30), and first/last-frame or reference modes.

For Meshy-compatible 3D models, choose a single-image or multi-image template and
standard or smart topology. Smart topology uses one image. Configure the face
count range, default and presets, plus texture and PBR support. These paths generate
GLB files from images. Meshy's rigging and animation library remain separate
capabilities of the built-in Meshy connection.

For Tripo-compatible services, choose **Tripo V3** and enter the model ID or gateway
alias. One reference uses the single-image endpoint; two to four references use
multiview in **Front / Left / Back / Right** order. The first reference is always
the front view. Set the face-count range for the model version: P1 supports up to
20,000 faces; standard V3.1 supports up to 1,500,000. Texture and PBR are optional;
disabling texture also disables PBR. Canvas converts WebP references to PNG before
upload; direct 3D tool requests accept PNG and JPEG.

The built-in **Tripo** provider only needs an API key in its provider detail page.
It includes P1, P2 (preview), V3.1, V3.0, and V2.5 using their documented V3 model IDs. Versions are pinned to keep saved projects
stable. The connection uses `https://openapi.tripo3d.ai/v3`; custom relays can use
their own Base URL and headers with the same protocol. Rigging and animation
continue to use the built-in Meshy connection.

The built-in **Hyper3D** provider uses your own API key and requires no OhMyGame
login. The same **Hyper3D** settings page also offers **Free account credits**.
The generation picker labels this account connection **Hyper3D · Free**; its
daily credits and model settings are managed separately from your API key.
Both sources include all five Gen 2.5 tiers, Gen 2, and the four Gen 1/1.5 tiers; the exact tier ID is
sent with the request. A preset does not guarantee that a key can access that
tier. Rodin accepts one to five PNG/JPEG images of the same object, without a
required Front/Side/Back sequence. Canvas shows neutral **Reference 1…5** labels.
The adapter uses GLB, Raw geometry, and Gen 2.5's explicit medium texture mode,
without add-ons. Displayed generation credits are estimates, not a live key balance.
Custom relays can choose the Hyper3D protocol and their own endpoint/model alias.

Built-in **Meshy**, **Tripo** and **Hyper3D** use the same searchable model list and visibility
controls as other providers. Choose **Edit**, then edit a model or **Add model**.
An added version uses its exact ID with the existing provider key and protocol;
start from an official template, then verify the new version's capabilities.
Language token fields are not required for 3D-only definitions.

Official presets allow display-name changes, default face counts, face-count
choices and default Texture/PBR settings. Their protocol and capability limits
stay fixed. **Restore defaults** restores the preset while keeping its visibility
preference. Manually added versions also allow capability editing and deletion.
Canvas controls and generation validation use the saved definition. Choosing a
different model applies its generation defaults; existing nodes keep their choices.

Enabled models appear in their corresponding canvas node's model selector.
Choose defaults in the Providers overview or Project settings, as described below.

## Existing configuration

Existing language models retain their settings. When an old custom provider's
image catalog is first loaded successfully, its previously available image models
are imported into the saved model configuration once. Subsequent catalog reads
use the saved choices and do not rediscover or re-enable image models.

The unified model definitions, uses, visibility and media defaults live in the
daemon's `model-visibility.json`, including native 3D versions and preset overrides.
Only language model definitions are projected to
Pi's `models.json`. Project overrides are stored in each project's `project.json`. Existing JSONC comments and unrelated SDK fields are preserved.
Credentials remain in the existing credential store and are not copied into model
definitions or returned in settings responses.

Connected provider details have a **Delete provider** button with inline
confirmation. For custom providers, it removes the provider definition, credential
and model settings. For built-in providers, including Meshy, Tripo and Hyper3D, it clears
the saved credential, endpoint overrides, custom models and visibility/enable
settings; the service remains available to connect again. Global media defaults
pointing to the deleted connection are reset. Project defaults and existing node
choices stay saved and need an available connection to generate again.

Deleting an official browser sign-in clears the local login only. It does not
cancel or change the service's subscription.

## Global and project defaults

The **Providers & Models** overview has global Image, Video and 3D selectors. Capability filters show the corresponding default. Provider details describe the provider's models; they do not define a separate default.

Open **Project settings** from the top right of Asset Canvas (or a project's Design view) to choose generation models in a compact menu. Global and project defaults use the same model picker as Canvas, with models grouped by provider. Changes save immediately. Closed selectors show only the effective model name; **Automatic** and **Use global** remain available in the model menu. Unused generation types can keep the global setting without a connected provider.

Generation uses the explicit node/request model first, then the project's default, then the global default. Global **Automatic** uses the first available model; when none is available, generation reports that a provider must be connected. An unavailable explicit or configured default produces an error instead of selecting another provider.

Changing defaults affects newly created nodes and requests without an explicit model. Existing nodes keep their saved choices. Both Canvas generations and project AI tools use this rule, and generation history records the resolved model so retries keep the original selection.

## Native 3D catalog updates

Official presets were checked against public documentation on 2026-10-10. Meshy
includes T2, 7.1, 7 (deprecated), 6, 6 Lite, and the `latest` alias. Tripo includes
`P1-20260311`, `P2-20260801` (preview), `v3.1-20260211`, `v3.0-20250812`, and
`v2.5-20250123`. Hyper3D includes ten Rodin tiers. Preview/deprecated entries
remain labeled, and listing a version does not verify the key's entitlement.

None of these providers documents a generation-model listing API. **Reload**
reloads the app's bundled presets and, for the unified Hyper3D page, refreshes the
server-authorized free catalog. It does not claim to discover upstream model IDs.
New official presets arrive with app updates; compatible versions can also be
added manually from the **Official model versions** link under catalog info. Saved
names, defaults, visibility, and model references survive reloads. Custom relays
with a compatible `/models` endpoint still support real discovery.

References: [Meshy OpenAPI](https://docs.meshy.ai/openapi.json),
[Tripo V3 versions](https://developers.tripo3d.ai/en/docs/models-and-versions),
[Tripo P Series](https://developers.tripo3d.ai/en/docs/generation-image-to-model/p),
and [Hyper3D Rodin](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5).
Rodin Agentic uses a separate beta endpoint and response contract; it is not
a tier for the current Rodin adapter. Bang, retexturing, rigging, and image
generation APIs likewise are not additional image-to-3D model versions.
