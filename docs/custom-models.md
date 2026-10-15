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

## Azure provider upgrade

Pi 1.2 uses provider ID `azure` in place of `azure-openai-responses`.
At startup, OhMyGame migrates saved credentials, custom model definitions,
Pi model preferences, and provider visibility settings. Existing `azure`
entries take precedence. JSONC comments and UTF-8 BOMs are preserved.
If a file is invalid, it is left untouched and the error is logged; other
files are still migrated. Correct the invalid file and restart to retry.

## OpenAI image connections

The built-in **OpenAI** page has an independent **Image models** section. Chat can
use **Browser sign-in** while images use a separate API key. An image-only OpenAI
connection also works when chat uses another provider.

Choose **Connect** (or the pencil beside a saved connection setting), then
**Separate API key and Base URL**. Enter the key for that endpoint and use
the default `https://api.openai.com/v1` or your compatible GPT Image relay's API
base, including `/v1` when required. **Fetch models** requests `{base}/models` with
the image key and previews recognized image models. Enable the models you want,
then choose **Save**. The section normally shows compact connection details and
enabled models; **Edit** reveals model management, and a model's pencil reveals
its capability template. Fetching checks the catalog, not generation
access, and does not save the draft or generate a paid image. A failed fetch keeps
the saved connection available. Changing the draft connection mode or Base URL
clears its model list and cancels an outstanding fetch. Replacing a key at the
same endpoint keeps model choices. **Cancel** restores saved settings.

If the service omits a model from its list, use **Add model** with its exact ID or
alias. Choose **GPT Image 1 / 1.5** for fixed sizes or **GPT Image 2 / 2.5** for
flexible sizes. The template defines available resolutions, aspect ratios and
reference limits; the request still sends the exact saved model ID. Refreshing
models keeps saved aliases, templates and enable choices, including models no
longer reported by the endpoint. Newly fetched models start disabled.

The endpoint must support OpenAI Images: `{base}/images/generations` for text
prompts and multipart `{base}/images/edits` for references. This connection uses
the configured service's API billing independently of a ChatGPT subscription.

An existing API-key chat connection can select **Use chat API connection** to
share its key and endpoint. Browser sign-in cannot be shared with images. Existing
API-key configurations retain their discovered image catalog until you save an
image list. Once saved, catalog reads and generation use that list without fetching
models again. Image models remain under provider ID `openai`, so existing Canvas
nodes and global/project defaults keep their references.

Image credentials and model settings live in the daemon's private
`openai-images.json` (file mode `0600`); settings responses omit the key, and Pi's
chat credential and model definitions are unaffected. Leave the key field blank
to keep its saved value for the same Base URL. A changed endpoint requires its
key to be entered again. A rejected image key reports an error without falling
back to the chat key or another provider.

The **Remove image connection** icon in edit mode clears the image key and models
and selects **Disabled**, leaving chat connected. To share chat's key afterwards,
select that mode explicitly. Deleting the provider clears both OpenAI connections and their
settings. Existing project/node choices remain saved and require an available
image connection to generate again.

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
output count. The application accepts up to 16 image references. Known model IDs
start with their model's reference count: GPT Image uses 16; Gemini 3 image models
use 14; Gemini 2.5 Flash Image uses 3. Provider-reported limits take precedence.
Unknown aliases start with one reference until you set the endpoint's supported
count. Saved limits are preserved; **Use model default** in Image settings can
restore a known model's reference count without resetting its other settings.
Video settings include resolutions, ratios, durations (1–30 seconds), reference-image limits
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

Chat and canvas text composers use one button showing the model name and current
reasoning level. Open it to choose a model, or choose **Reasoning** in the menu to
adjust the depth. Only levels supported by the selected model are listed; models
with just one supported level show only their name. Choosing a different model
keeps the current level when supported, or adjusts it to a supported level. The
extra-high level is displayed as **xHigh**.

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

Connected provider details end with a **Remove provider** section; **Remove…**
opens an inline confirmation with **Delete provider**. Meshy, Tripo and Hyper3D
keep a **Remove API key** button beside their key field instead. For custom providers, it removes the provider definition, credential
and model settings. For built-in providers, including Meshy, Tripo and Hyper3D, it clears
the saved credential, endpoint overrides, custom models and visibility/enable
settings; the service remains available to connect again. Global media defaults
pointing to the deleted connection are reset. Project defaults and existing node
choices stay saved and need an available connection to generate again.

Deleting an official browser sign-in clears the local login only. It does not
cancel or change the service's subscription.

Provider details start with a **Providers & Models** breadcrumb and a status
line such as **Connected · ChatGPT**. Built-in language providers show a
**Connection** row for the current sign-in (**Reconnect**) or API key (edit
icon); when the provider offers both methods, the section heading has a button
to switch. The model list shows the global default language model
first with a **Default** badge; hidden models stay under **Hidden models (n)**.
Base URL and Responses connection settings sit in the collapsed **Advanced**
section, and the page ends with **Remove provider**.

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

## 3D operations

Model 3D supports image/text generation, retexturing and Meshy/Tripo remeshing.
Animate 3D selects Meshy or Tripo independently of generation-model visibility.
Compatible custom connections opt into additional operations in their 3D capability
settings. See [3D provider workflows](3d-providers.md) for operation inputs, rig and
texture versions, task recovery, GLB checks and the remaining documented APIs.
