# Maintainer workflow

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for contributor-facing rules and
[the label workflow](../.github/LABELS.md) for issue states. This guide covers
maintainer decisions and the transition to `dev` as the development branch.

## Branches

- `dev` integrates ordinary contributions.
- `main` receives reviewed releases from `dev` and exceptional release fixes.
- Contribution branches use the prefixes in `CONTRIBUTING.md`.

Ordinary PRs can be squash-merged after review. Merge `dev` into `main` with a
merge commit so both long-lived branches retain their shared history. Keep
both branches; automatic cleanup should apply to finished contribution branches.

## GitHub setup and transition

Creating `dev` does not change GitHub's default branch or enable branch rules.
Repository administrators should complete these steps when adopting the workflow:

- [ ] Set the default branch to `dev`. This makes new PRs target development and
      lets closing keywords resolve issues when those PRs merge.
- [ ] Enable rules for both `dev` and `main`: require a PR, at least one review,
      and the `check` status from CI. Confirm the status name in GitHub's selector.
- [ ] Block branch deletion and force pushes on both long-lived branches.
      These rules also keep GitHub's automatic head-branch deletion from
      removing them.
      Keep merge commits enabled for release and synchronization PRs.
- [ ] Verify a fork PR into `dev` runs CI without release or cloud secrets.
      Run the same public checks for docs PRs; contributors may use the lighter
      local documentation checks described in `CONTRIBUTING.md`.
- [ ] Review existing PRs targeting `main` with their authors. Retarget ordinary
      contributions to `dev`, check the resulting diff and conflicts, and wait
      for fresh CI and review. Keep actual release fixes on `main` when needed.
- [ ] Check issue links during the transition. While `main` remains the default,
      a PR merged into `dev` does not automatically close its linked issue.

These settings are administrative work; editing documentation or workflows
does not apply them. The CI workflow covers all PR targets and pushes to both
long-lived branches.

## Issue triage and starter tasks

Confirm reproduction details and choose a type and relevant areas. Use
`flag: needs-info` for a specific missing detail, link duplicates to their
original issue, and explain acceptance, postponement, or closure. Keep one
status label on each open issue using the existing label workflow.

Maintain a small set of three to five starter tasks when suitable work is
available. Before adding `good first issue`, include:

- The concrete problem and expected behavior.
- The likely code/documents to read and a bounded scope.
- Reproduction steps and useful tests or manual checks.
- Acceptance criteria and any environment or private-service requirement.

Use `help wanted` for accepted work open to community contributions. Confirm
scope with a contributor before they begin substantial work, and record who
is working on the task to avoid duplication. Assign issues when GitHub allows
it; otherwise a comment is enough. Update progress and blocker flags as work
moves into implementation and review.

## Review and merge

Check that ordinary contribution PRs target `dev`, have a focused scope and
Conventional Commit title, and explain what changed, why, and how they were
checked. An issue is optional for a straightforward fix or documentation
correction. Release and urgent-fix PRs follow the release preparation below.

Review behavior, relevant tests, public contracts, and documentation together.
Check screenshots or recordings for visual changes and validate desktop-specific
flows in Electron when browser checks cannot exercise them. Confirm CI passed
for the latest revision and resolve substantive review comments before merging.

Public checks do not require the private `ohmygame-cloud` repository.
`test/publish.test.ts` skips its remote contract suite when that checkout or
its dependencies are unavailable. For changes to the publishing boundary,
a maintainer with access installs the cloud dependencies, selects the checkout
with `OHMYGAME_CLOUD_ROOT` if needed, and runs `bun run test:publish-contract`.
Confirm the remote suite ran without skips and record both repository revisions
and results. Run staging checks when auth, provider behavior, quota settlement,
or deployment compatibility is affected.

After merging, close fully resolved issues or explain what remains. Clean up
the contribution branch and keep `dev` and `main`. If a PR stalls, describe the
remaining work and an actionable next step before closing it.

## Release preparation

1. Prepare the version in `package.json` and its user-visible release notes in
   [CHANGELOG.md](../CHANGELOG.md) through a focused `chore/<short-name>` branch
   and PR into `dev`. Collect changes from merged PRs since the previous release;
   ordinary PRs do not update the changelog. Follow the
   [changelog format and checks](desktop-releases.md#release-notes).
   Also list compatibility code that is due with `git grep -n "compat:"` and
   remove it in a PR into `dev` first; see [compatibility](compatibility.md).
2. Verify the release candidate's public checks and relevant platform, model,
   OAuth, and cloud integration behavior. Record environment-dependent checks
   that remain outstanding. When a change affects packaging or the installer,
   build the packages with a
   [manual release workflow run](desktop-releases.md#publishing) and install
   them before tagging.
3. Push a temporary branch at `dev`'s current commit, for example
   `git push origin origin/dev:refs/heads/chore/release-v0.0.0-beta.4.7`, and
   open the release PR from that branch into `main`, with a title such as
   `chore(release): prepare v0.0.0-beta.4.7`. Review the included changes and
   merge with a merge commit. Never use `dev` itself as the head: the
   repository deletes head branches after merge, and deleting `dev` closes fork
   PRs that target it and retargets the rest to `main`.
4. Create the matching version tag on the reviewed `main` commit. Pushing a
   `v*` tag starts the desktop release workflow, which validates the version and
   changelog before either platform builds. See
   [desktop-releases.md](desktop-releases.md) for credentials, packaging,
   publication, and rollback.
5. Synchronize `main` into `dev`, since the release merge commit exists only on
   `main`. Push a temporary branch at `main`'s commit, for example
   `chore/sync-main-v0.0.0-beta.4.7`, open a PR from it into `dev`, and merge
   it with a merge commit.

If `dev` is deleted anyway, push it back at its last commit
(`git push origin <sha>:refs/heads/dev`), reopen the PRs GitHub closed when it
disappeared, and retarget any PRs that GitHub moved to `main` back to `dev`.

For an urgent released-version fix, start a `fix/<short-name>` branch from
`main` and open a PR into `main`. After review and verification, synchronize
`main` back into `dev` through a merge PR so the fix is included in later releases.

## Publishing the plugin author packages

`@ohmygame/plugin-ui`, `@ohmygame/plugin-cli` and `create-ohmygame-plugin`
carry the plugin API version, `PLUGIN_HOST_API_VERSION` in
`src/shared/plugin-manifest.ts`, and a test keeps their `version` equal to it.
When a release raises that version, publish all three from that release's
commit once the release is out, since a plugin they make needs its plugin API.
Sign in to npm as a member of the `@ohmygame` organization, and check each
package's files with `npm pack --dry-run` first:

```sh
(cd packages/plugin-ui && npm publish --access public)
(cd packages/plugin-cli && npm publish --access public)
(cd packages/create-ohmygame-plugin && npm publish)
```

The last two build their `dist/` from the app's code before packing
(`prepack`), so run them from a checkout with dependencies installed.

## Publishing the SDK

`@ohmygame/sdk` is released on its own, from the
[SDK release workflow](../.github/workflows/release-sdk.yml), whenever its
changes should reach games; the desktop app copies the SDK from this repository
and does not wait for it.

1. In a PR into `dev`, raise `version` in `packages/sdk/package.json` and add
   its section to `packages/sdk/CHANGELOG.md`, `## [0.0.3] - YYYY-MM-DD`,
   listing what games and their developers can notice. Run `bun install` so
   `bun.lock` records the new version. A change to the room protocol also
   follows [protocol versions](multiplayer.md#protocol-versions): add a version,
   never change one games already speak.
2. Optionally run the workflow by hand on that branch: it runs every check and
   packs the package without publishing it. GitHub offers the manual run only
   once the workflow is on `main`.
3. Once the PR is merged, tag the merge commit `sdk-v<version>`, for example
   `git tag sdk-v0.0.3 <commit> && git push origin sdk-v0.0.3`. The workflow
   checks that the tag, `package.json` and the changelog agree, runs the SDK's
   tests, and publishes with npm provenance.

The workflow publishes with the `NPM_TOKEN` repository secret, an npm
automation token of a member of the `@ohmygame` organization. A tag whose
version is already on npm fails at the publish step; raise the version instead.
