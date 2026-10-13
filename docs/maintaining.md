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

1. Prepare version and release documentation changes through a focused
   `chore/<short-name>` branch and PR into `dev`.
2. Verify the release candidate's public checks and relevant platform, model,
   OAuth, and cloud integration behavior. Record environment-dependent checks
   that remain outstanding.
3. Open a release PR from `dev` into `main`, with a title such as
   `chore(release): prepare v0.0.0-beta.4.7`. Review the included changes and
   merge with a merge commit.
4. Create the matching version tag on the reviewed `main` commit. Pushing a
   `v*` tag starts the desktop release workflow. See
   [desktop-releases.md](desktop-releases.md) for credentials, packaging,
   publication, and rollback.
5. If release work introduced commits only on `main`, open a synchronization
   PR from `main` into `dev` and merge it with a merge commit.

For an urgent released-version fix, start a `fix/<short-name>` branch from
`main` and open a PR into `main`. After review and verification, synchronize
`main` back into `dev` through a merge PR so the fix is included in later releases.
