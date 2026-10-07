# Test Suite Ablation - 2026-10-07

The original suite passed all 1,046 tests in 129 files, but detected only 10 of
12 deliberately injected regressions. Every test layer made an independent
contribution in this sample. Removing a whole layer lost two or three more
detected regressions. The experiment does not support deleting a whole layer.

Two missing boundary tests were added after preserving the original results:
incorrect Bearer tokens and duplicate/stale renderer events. These are test
coverage gaps; the production safeguards already implement the correct behavior.

## Project and Test Boundaries

OhMyGame is a local-first game creation studio. React/Vite renders the editor,
Fastify manages projects, assets and Pi agent sessions, Electron owns desktop
windows and playtest input, and shared modules define story state, navigation,
runtime events and file contracts. Vitest uses the Node environment. Tests mix
pure functions, static React rendering, mocked providers/Electron, local HTTP
servers, temporary filesystem workspaces and real esbuild/Vite builds.

| Layer    | Files | Original tests | Examples                                            |
| -------- | ----: | -------------: | --------------------------------------------------- |
| Shared   |    21 |            147 | Story runtime, graph, state, model selection        |
| Daemon   |    60 |            527 | Agent sessions, HTTP API, persistence, publishing   |
| Renderer |    42 |            326 | UI rendering, editor serialization, event reduction |
| Desktop  |     6 |             46 | OAuth, windows, IPC, clipboard, proxy               |

The runner parses test sources with TypeScript's AST, including dynamic imports
and mock module references. Type-only import declarations are excluded. Mixed
files belong to the first matching layer in `desktop > daemon > renderer > shared`
order. `playable-vite.test.ts` is explicitly a Renderer test because it loads
the renderer's Vite configuration rather than importing a source module.
These are ownership groups, not a classification into unit/integration/E2E tests.

## Method

- Copy current repository files into an isolated temporary directory and share
  only the installed `node_modules` directory. Mutate only the copied sources.
- Run the full suite and each leave-one-layer-out variant three times, rotating
  order between repetitions. Use four workers and measure process wall time,
  including startup, collection and teardown. Report medians.
- Inject one of 12 source mutations at a time and run the full original suite.
  Record failing assertions, files and their owner groups. Reject incomplete,
  skipped, timed-out or collection-failed runs.
- Project detection after a layer is removed by retaining failures in other
  groups. Actually rerun S1 without Shared, D2 without Daemon, R1 without
  Renderer and E1 without Desktop. Compare exact failing test identities.
- Restore copied sources between mutations, verify the original target source
  files are unchanged, and remove the temporary copy on exit.

The non-verified cells of the leave-one-layer-out detection matrix are
projections. They assume isolated test files behave the same when other files
are omitted. All four verification runs matched those projections.

## Original Results

All 15 clean-code runs passed. Detection below is over the same 12 injected
regressions, not code coverage or an estimate of all possible defects.

| Variant          | Tests retained | Median seconds | Time saved | Detected | Missed |
| ---------------- | -------------: | -------------: | ---------: | -------: | -----: |
| Full             |          1,046 |          16.48 |       0.0% |    10/12 |      2 |
| Without Shared   |            899 |          14.61 |      11.3% |     7/12 |      5 |
| Without Daemon   |            519 |           5.54 |      66.4% |     8/12 |      4 |
| Without Renderer |            720 |          12.29 |      25.4% |     8/12 |      4 |
| Without Desktop  |          1,000 |          15.74 |       4.5% |     7/12 |      5 |

| ID  | Injected regression                                          | Original detector files                          | Failed cases |
| --- | ------------------------------------------------------------ | ------------------------------------------------ | -----------: |
| S1  | Drop the return location on push navigation                  | `playable-navigation`, `playable-runtime`        |            2 |
| S2  | Return state snapshots without cloning                       | `playable-state`                                 |            1 |
| S3  | Prefer the default model over the explicit selection         | `agent-models`                                   |            1 |
| D1  | Accept any parsed Bearer token without comparing its content | None                                             |            0 |
| D2  | Ignore the configured package manager                        | `package-manager`                                |            1 |
| D3  | Stop extracting private editor context                       | `agent`, `game-design-context`, `prompt-context` |            4 |
| R1  | Apply events from another conversation                       | `renderer-state`                                 |            1 |
| R2  | Lose the draft when leaving prompt history                   | `prompt-history`                                 |            2 |
| R3  | Process events whose ID equals the current cursor            | None                                             |            0 |
| E1  | Permit navigation away from the renderer                     | `window`                                         |            1 |
| E2  | Accept fractional viewport dimensions                        | `window`                                         |            1 |
| E3  | Play audio from a hidden window                              | `window`                                         |            1 |

Detector names are stems under `test/`, with `.test.ts` appended. Each detected
mutation had failures in exactly one group. There was no cross-group replacement
coverage for these samples. S1 and D3 had multiple detector files within their
group, but this does not prove those tests are redundant: runtime integration,
prompt submission and persisted conversation display are different contracts.

Removing Desktop saves only 0.74 seconds while losing three detected samples.
Removing Shared saves 1.87 seconds while also losing three. Daemon is the largest
time contributor, but removing it loses package-manager and context regressions.
Prefer focused local test runs during development and keep the full suite as
the merge gate. Optimize slow setup/build work before reducing test layers.

## Gaps and Follow-Up Validation

`test/access.test.ts` now rejects incorrect tokens of the same length, a shorter
length and a longer length. This covers the comparison branch that the original
missing-token and valid-token tests did not exercise.

`test/renderer-state.test.ts` now replays an identical queue event and an older
event. It checks that the queue content stays unchanged and the cursor does not
move backwards, protecting idempotency without relying on object identity.

Follow-up checks passed the full 1,048-test clean baseline and all four clean
leave-one-layer-out variants, then re-injected D1 and R3. Both previously missed
regressions now fail the newly added assertion in their respective test file.

| Mutation | Before                   | After                            | New detector                  |
| -------- | ------------------------ | -------------------------------- | ----------------------------- |
| D1       | Undetected; 1,046 passed | Detected; 1,047 passed, 1 failed | `test/access.test.ts`         |
| R3       | Undetected; 1,046 passed | Detected; 1,047 passed, 1 failed | `test/renderer-state.test.ts` |

The original timing and mutation tables above refer to the original 1,046-test
suite; the other ten mutations are not repeated after adding the two tests.
`npm run typecheck` also passed after the additions. No production code changed.

## Conditional Publish Tests

`test/publish.test.ts` skips 19 remote publish contract cases when the adjacent
`ohmygame-cloud` repository or its installed dependencies are missing. The
current CI workflow checks out only this repository, so those cases are normally
skipped there. The initial temporary copy exposed this dependency by losing the
relative sibling path; that incomplete run was excluded from the measurements.

The experiment pins `OHMYGAME_CLOUD_ROOT` to the original absolute dependency
path and refuses skipped tests. Consider a dedicated publish-contract CI job
that prepares the cloud repository and asserts that no cases were skipped.

## Reproduction and Evidence

Measured environment: Apple M4, macOS arm64, Node `v24.14.1`, Vitest `3.2.6`, four
workers. Project revision: `16bbec37b26d74267b2d7a65dca58b217ab1b766`.
Cloud revision: `cd580f5654e37810dddc63642c1f54b17c3255b0`.
The original experiment started on 2026-10-07 at 11:12 China Standard Time.

```bash
npm run test:ablation -- --dry-run
npm run test:ablation
npm run test:ablation -- --runs=1 --mutant=D1,R3
# Resume a checkpoint with the same inputs, mutation selection and repetition count:
npm run test:ablation -- --resume=.data/test-ablation/<run>/results.json
```

Install this repository's dependencies first. Prepare the cloud repository and
its dependencies beside it, or set `OHMYGAME_CLOUD_ROOT` to its absolute path.
The runner is in `scripts/test-ablation.mjs`; it checkpoints JSON results after
each completed run and stores individual Vitest JSON reports and logs under
`.data/test-ablation/` (ignored by Git).

Original evidence:
[`results.json`](../../.data/test-ablation/2026-10-07T03-12-51-712Z/results.json).
Follow-up evidence:
[`results.json`](../../.data/test-ablation/2026-10-07T03-21-18-818Z/results.json).

The 12 samples were deliberately selected after reading the code and tests,
with three mutations per source layer. This selection is small and not random;
83.3% is the original sample detection rate, not a project-wide quality score.
Three timing repeats do not establish statistical significance. Cached shared
dependencies, local CPU load and platform differences affect these measurements.
No real provider quality, browser interaction, screenshot, WebGL rendering or
packaged Electron behavior was measured by this experiment.
