# 3D provider workflows

Reviewed against public API documentation on 2026-10-11. These capabilities describe
own-key connections. Free cloud currently exposes image-to-3D only, according to
its server catalog; signing in does not enable additional upstream operations.

| Operation | Meshy | Tripo V3 | Hyper3D Rodin |
| --- | --- | --- | --- |
| Image / multiview generation | Yes | Yes | Yes, unordered references |
| Text generation | Preview geometry, then optional refine | Text-to-model | Rodin with prompt and no images |
| Retexture an external GLB | Text **or** one style image | Text **or** one image | One model **and** one image; optional prompt |
| Remesh / reduce faces | Triangle remesh | v3.0 decimate, triangle mesh, texture baking | No documented equivalent |
| Rig and preset animations | Textured humanoid, facing +Z, ≤300k triangles | Rig-check, rig, then retarget | No documented full rig/animation API |
| Action library | Live numeric IDs and previews | Bundled identifiers scoped to rig version/type | — |
| Own-key balance | Balance | Available and frozen credits | Remaining credits |

## Canvas and agent tools

The **Model 3D** node has Image to 3D, Text to 3D, Retexture, and Remesh modes. Text
and retexture prompts can connect to Text or Document nodes. Processing modes take
a source GLB connection. Retexture also accepts a style image; Hyper3D always needs
one. The source asset is preserved, and each result becomes a new Library asset.

**Animate 3D** has an explicit connection selector. Existing saved nodes without a
selector retain Meshy's numeric action IDs. Changing connection, Tripo rig version,
or rig type clears incompatible moves. Tripo v1 provides the documented humanoid
preset library; v2.5 provides biped and supported creature preset subsets. Avian
rigging has no documented retarget preset in the current catalog and is not exposed.

Generation model IDs identify geometry versions. Texture and rig selectors identify
their own operation versions: Tripo texture defaults to `v3.5-20260815`, rig to
`v1.0-20240301`, and decimation to `v3.0`; Meshy retexture defaults to `latest`.
Tripo's Fast texture quality requires texture v3.5. Generation pose controls map to
Meshy `pose_mode` or Rodin `TAPose`. Other unsupported option combinations fail
before paid submissions.

The existing `image-to-3d` agent tool accepts an `operation`, optional `prompt`,
`imagePath`/`imagePaths`, and processing `sourcePath`. Its identifier stays unchanged
for existing tool permissions. The `animate-3d` agent tool accepts the connection and
Tripo rig settings and resolves action names through that connection's library.

Native processing and animation connections remain available when generation models
are hidden. Each native provider appears once in these selectors, using the stable
`connection` ID; older geometry-version references still resolve to that connection.
Generation selectors keep their geometry versions. Moves load when the picker opens.
Meshy's supplied previews appear as cards; providers without preview URLs, including
Tripo's documented presets, use a searchable name list with ordered selection.
Own-key balances live in provider settings, using one balance per compatible
protocol/base URL for custom connections. Hyper3D's free daily quota and per-generation
cost remain in the canvas because they affect the selected model's availability.
A custom 3D model stays generation-only until **Compatible 3D operations**
explicitly enables additional endpoints. Compatible calls honor the model's base
URL override, auth mode and runtime headers. A custom Meshy URL ending in `/v1`
uses the documented sibling `/v2` for text tasks; a relay with a different layout
must route `text-to-3d` at its configured base. Capability opt-in does not establish
that a relay actually implements an endpoint.

## Recovering paid tasks

Canvas history and standalone tool history save resolved inputs. Each logical 3D
job also has a private task journal under `tools/model3d-tasks/`. Jobs sharing a
recovery ID reuse confirmed stages, including when a duplicated project retries
while the original is running. The daemon serializes submissions to each journal
and reads its latest saved stages; polling and downloads can run independently.
Before submission, it records a stage fingerprint; after the response, it records
task credentials.
Fingerprints cover the endpoint, authentication/headers and effective request body.
API keys are hashed into fingerprints and never saved in the journal. Hyper3D's
subscription credential stays in the private journal; it is not included in public
jobs or assets. Journal and standalone history files use owner-only permissions.
Canvas history stays in the project's existing `canvas/jobs.json`.

Meshy reuses an available rig for the same source, height and orientation across jobs
in the running daemon. The reused rig is also recorded in the new job's journal, so
its retry can recover after restart. Custom connections reuse their adapter while
the endpoint, settings, authentication and headers remain unchanged.

**Retry** resumes known upload, generation, refine, rig-check, rig and animation
tasks, including a failed artifact download. It does not resubmit a known failed
provider task. Starting Generate again creates a new logical job. If a submission
response was lost before its task ID could be recorded, retry reports the ambiguity
and refuses another paid POST; inspect the provider dashboard before starting again.
Changing a connection or effective input blocks recovery until the original settings
are restored. Expired/deleted upstream artifacts cannot be recovered from the API;
locally saved successful assets remain available.

Cancellation stops local waiting. It does not promise provider cancellation or a
refund. Restarted interrupted jobs remain in history for explicit retry. Provider
operations allow up to 60 minutes overall, with bounded individual API requests.
Free cloud retains its separate server-managed idempotency and quota contract.

## Model checks and interoperability

New results are parsed as GLB and must contain triangle geometry. Library and canvas
metadata records triangle counts, textures, skins, animation names, origin operation,
connection and known forward axis. Meshy preflight rejects untextured or oversized
sources. Tripo performs its own asynchronous riggability check before rigging.

Tripo-generated geometry uses its documented +X forward axis. When sent to Meshy
rigging, a new scene parent rotates it to +Z while preserving local skeleton and
animation coordinates. The original asset and intermediate Tripo tasks retain their
coordinates. Models imported without known axis metadata still need a suitable
orientation; geometry inspection cannot infer a character's semantic front or
whether it is humanoid. Unsupported compressed GLBs report a decode error rather
than silently passing geometry checks.

## Documented capabilities still outside this implementation

| Provider | Further documented APIs / options |
| --- | --- |
| Meshy | Text to Motion; standalone rig/export; format conversion; resize; UV unwrap; task management and usage history; additional generation controls including geometry/texture resolution, seeds, texture guidance, automatic size and thumbnails |
| Tripo | Image generation and multiview-image/edit APIs; import/convert; Smart UV and preview; segmentation/completion; standalone rig/export; task listing/cancellation and usage history; seeds, geometry quality, automatic size, low-poly/parts generation and compression; large-file presigned uploads |
| Hyper3D | Bang and Rodin Agentic beta; usage history; texture resolution/mode, seed, lighting removal, reference strength/detail controls; bounding-box/size and further tier-specific controls |

Retexture and preset rig/animation are the common workflows covered here. Standalone
conversion, UV work, segmentation/completion, text-to-motion, Agentic and alternative
file formats need their own input/output contracts and capability declarations.
The current artifact path intentionally saves GLB only; it does not label FBX, OBJ
or multipart/segmented outputs as GLB.

## References

- [Meshy OpenAPI](https://docs.meshy.ai/openapi.json), [text generation](https://docs.meshy.ai/api/text-to-3d), [task lifecycle](https://docs.meshy.ai/api/task-lifecycle)
- [Tripo documentation](https://developers.tripo3d.ai/en/docs/models-and-versions), [retargeting](https://developers.tripo3d.ai/en/docs/animations-retarget), [retexture](https://developers.tripo3d.ai/en/docs/models-texture)
- [Rodin generation](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5), [retexture](https://docs.hyper3d.ai/en/api-specification/generate-texture), [balance](https://docs.hyper3d.ai/en/api-specification/check-balance)

Validation uses real GLB fixtures and mocked API contracts. It does not establish
live account entitlement or spend provider credits; live acceptance of selected
versions depends on the provider account and compatible server implementation.
