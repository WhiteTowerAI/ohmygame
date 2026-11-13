---
name: taptap-h5-publish
description: Upload an existing H5 web game to TapTap, bind its package, prepare its store page, and submit review or check release status with the official taptap-cli. Use for TapTap H5 publishing, not Maker development.
---

# TapTap H5 publishing

Keep the project's engine, source, project type and web preview. Publish its
web build through `taptap-cli`; do not initialize Maker, convert it to Lua,
create a Spark build, or use OhMyGame Community publishing for this task.
An upload-only request ends after verifying the remote package. A request to
check status does not upload, bind, create a draft or submit review.

## Panel and CLI

The TapTap panel connects a developer/game, reads store modules and versions,
and discovers/prepares/uploads a web build using the official CLI. It edits
ordinary text and image fields directly and binds ready H5 packages after
checking the current draft and expected snapshot. Local unsaved edits survive
refresh and reopening; remote drift is refused. Image upload only adds to the
material library until Save draft applies it. Review, release, video and other
advanced settings remain explicit agent/console workflows. Panel uploads are
not automatically bound or submitted.
Use `taptap_status` to read the saved target and receipts instead of uploading
again. After reconciling a panel upload through CLI task history, call
`taptap_reconcile_upload` with its upload ID and recovered artifact ID; the
server filename must match the recorded ZIP before the panel accepts it.

## CLI and target game

Run `taptap-cli version` and `taptap-cli auth status`. If unavailable, use the
official installation instructions at https://developer.taptap.cn/v3/cli/ and obtain
any missing installation authorization. Do not update the CLI during a write
workflow. Use its browser device login (`auth login --no-wait --json`), retaining
the full expiry and polling parameters to finish authorization. Never request
tokens or store credentials in the game project.

Read `taptap-cli skills read taptap-cli`, then the embedded business Skill for
the current step. Read its references with `taptap-cli skills read
<skill-name>/<relative-path>`; these resources come from the installed CLI,
not from OhMyGame or the current working directory. Inspect service arguments
with `schema <service> <method>` and upload/task arguments with `--help`.

| Step                                            | Embedded Skill              |
| ----------------------------------------------- | --------------------------- |
| Login, developer and app discovery              | `taptap-identity`           |
| Create a game only when needed                  | `taptap-publish-game`       |
| Upload ZIP, icon, banners or captures           | `taptap-materials`          |
| Parse status, H5 versions and test entry        | `taptap-package-management` |
| Store page, package binding, review and release | `taptap-app-edit`           |
| Actual qualification gaps                       | `taptap-qualification`      |

Reuse a known, authorized developer/app pair after checking its current H5
capability. If ambiguous, show game names and developers for selection; do not
choose the first result. Create a new app only when requested, with the actual
H5 package direction; H5 does not imply a level/creative-workshop game. A
missing permission or unavailable H5 capability is not a reason to create a
duplicate app or change the app's declared package type.

## Build and package

1. Inspect the project's instructions and build/export configuration. Finish
   the intended production web build and verify its `index.html`, scripts and
   assets. Use the existing engine's web export when applicable. Never package
   the source repository or assume every project outputs `dist/`.
2. Exercise the built game in the existing preview: loading, asset URLs,
   gameplay and the intended phone orientation. Relative asset URLs must work
   from a nested deployment path. Identify localhost dependencies, development
   servers or backend/SDK features needing deployment; a ZIP cannot deploy a
   server or provision platform services. Report unverified target behavior.
3. For a build folder, run the helper below from the game workspace using its
   absolute path resolved relative to **this Skill's directory**:

   ```text
   node <skill-directory>/scripts/package-h5.mjs <build-folder> <new-output.zip>
   ```

   Node 22.19+ is supported. Both paths must be in the workspace; the output
   parent must exist, outside the build folder. Prefer a new ASCII filename
   under `.ohmygame/local/taptap/`. The helper returns the absolute ZIP path,
   SHA-256, byte size and file count. It creates `game/index.html` with assets
   under the same `game/` directory, refuses symlinks/source metadata and
   existing outputs, and skips macOS metadata. It does not build or upload.
   Review any returned hidden-file warnings before uploading. For an existing
   user-provided ZIP, inspect it and use the CLI preflight directly; do not
   rebuild or replace a valid supplied artifact without a reason.

4. Read `upload-h5-package --help`, confirm orientation (`0` landscape, `1`
   portrait), and run its `--dry-run` with the selected app/developer. Require
   `data.archive_preflight` to pass: exactly one top-level game directory with
   `index.html` directly inside it and no violations. Root-level `index.html`
   is invalid. Execute from the workspace: the CLI rejects files outside it.

## Upload and bind

Preview the target game, artifact and orientation. Reuse existing authorization
for that concrete upload; ask only if its target or scope is still missing.
Run the same `upload-h5-package` input with `--yes` instead of `--dry-run`,
using a stable idempotency key for this intent. Keep the ZIP unchanged between
preview and execution. The official CLI owns multipart upload and task recovery;
do not call low-level prepare/complete APIs or implement a parallel uploader.

Retain the receipt's `cliTaskId`, `artifactId`, `h5VersionId` and `h5PackageId`
when present. A partial failure or `readbackErrors` may already have created the
version. Use `task +get` / `task +resume` per their current help and embedded
Skill, or query `package-management get-h5-package-upload-status` using
`artifactId` as `artifact_id`. Neither a package ID nor a version ID substitutes
for that handle. Poll processing with bounded waits; report failed/unknown
outcomes accurately. Do not upload again merely because readback failed.

For a release request, use `app list-packages` to find the intended **ready H5**
candidate and the same response's `package_slots.main`. Bind only when the
slot is available and supplies `expected`; copy the candidate ID and snapshot
without changing their types. Preview `app select-package` with `slot: main`
and `package.type: h5`, execute within the user's authorization, then read back
the binding. If already bound, keep it. On stale state, reread; never use
`force` to overwrite someone else's change. H5 uses the main slot even for PC
distribution, never the Windows or Spark slot.

## Store page, review and release

Follow the current `taptap-app-edit` Skill and its review references for the
rest of the workflow. Read actual modules, requirements, qualification gaps
and `platform-status`; preserve unrelated draft fields and distribution
choices. Use current field specifications for images/video, and real game
captures for screenshots and gameplay footage. Preview material changes and
use current `expected` values, then read them back. Do not invent legal facts,
sign agreements or expand distribution without the user's decision.

Once review is requested, prepare the review snapshot, run the precheck and
show the concrete version, package, changes, blockers, warnings and release
timing before final submission. Use the same selected `release_schedule` for
precheck and submit; a changed review version requires a fresh snapshot. An
unavailable precheck is unknown, not passed or rejected. Respect an explicit
choice to submit despite disclosed warnings under the current CLI contract.

After submission read the version and platform states. Distinguish uploaded,
parsed, bound, submitted, scheduled and online. Review acceptance is not live
publication, and an online version does not itself enable a distribution
entry. Give returned store/test links, remaining work and the next action.
On ambiguous writes, reconcile existing handles before retrying; do not
change idempotency keys or repeat an unknown create/upload/submit operation.
