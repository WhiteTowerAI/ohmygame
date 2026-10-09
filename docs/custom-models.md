# Custom providers and models

In **Providers & Models**, choose **Add provider**, enter a name, Base URL and
authentication, and select a service preset if one fits your endpoint. Presets
provide connection defaults; each model can use its own generation protocol.
The default language protocol also determines how the general model list is fetched.
Custom provider names must be unique, ignoring case and surrounding spaces.
Existing duplicate names remain usable while you rename them.

Choose **Fetch** to load the complete model list, or **Add a model manually** to
enter a model ID that the endpoint does not list. Model discovery is optional;
services such as Meshy may require manual IDs. Discovery never generates media.

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

Enabled models appear in their corresponding canvas node's model selector.
Choose defaults in the Providers overview or Project settings, as described below.

## Existing configuration

Existing language models retain their settings. When an old custom provider's
image catalog is first loaded successfully, its previously available image models
are imported into the saved model configuration once. Subsequent catalog reads
use the saved choices and do not rediscover or re-enable image models.

The unified model definitions, uses, visibility and media defaults live in the
daemon's `model-visibility.json`. Only language model definitions are projected to
Pi's `models.json`. Project overrides are stored in each project's `project.json`. Existing JSONC comments and unrelated SDK fields are preserved.
Credentials remain in the existing credential store and are not copied into model
definitions or returned in settings responses.

## Global and project defaults

The **Providers & Models** overview has global Image, Video and 3D selectors. Capability filters show the corresponding default. Provider details describe the provider's models; they do not define a separate default.

Open **Project settings** from the top right of Asset Canvas (or a project's Design view) to choose generation models for that project. Each selector can inherit the global setting or use a specific connected model. Inheritance shows the effective provider and model. Unused generation types can stay inherited without a connected provider.

Generation uses the explicit node/request model first, then the project's default, then the global default. Global **Automatic** uses the first available model; when none is available, generation reports that a provider must be connected. An unavailable explicit or configured default produces an error instead of selecting another provider.

Changing defaults affects newly created nodes and requests without an explicit model. Existing nodes keep their saved choices. Both Canvas generations and project AI tools use this rule, and generation history records the resolved model so retries keep the original selection.
