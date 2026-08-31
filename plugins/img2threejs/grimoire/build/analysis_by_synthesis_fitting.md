# Analysis-By-Synthesis Fitting

This is the WS4 fitting loop for v1.5. It ties the deterministic parameter search
to Divine Eye so the loop behaves like a bounded artist correction pass, not a
free-running guesser.

`forge/stage4_review/fit_params.py` provides pure-stdlib, deterministic bounded
coordinate descent for analysis-by-synthesis parameters. Use it to tune a small
rendering or scene vector only when the caller can provide a deterministic objective.

## API And Limits

```python
result = fit(initial, bounds, objective, FitConfig())
```

- `initial` has 1 through 15 finite, non-boolean numeric parameters.
- `bounds` has one `[lower, upper]` finite pair for each parameter. The lower value
  is strictly less than the upper value, and every initial value is in range.
- `objective(parameters)` returns a finite score. Higher scores are better.
- Candidate order is fixed: for every coordinate, evaluate the bounded lower move,
  then the bounded upper move. `seed` is metadata only; no random source is used.
- `max_iterations` and `max_evaluations` are hard limits. The fitter additionally
  stops on a configured plateau or consecutive coordinate-direction thrashing; flip
  tracking applies only to consecutive iterations whose net gain is below
  `min_improvement`. Each unstable iteration with at least one reversal advances the
  thrash streak once; tracking resets after a stable iteration or one without a
  reversal. This keeps normal bracket refinement, one multi-coordinate reversal,
  and non-consecutive flips out of the `oscillation` stop condition.
- If the evaluation budget blocks the second direction for a coordinate, an already
  evaluated better first-direction proposal is committed and recorded before the
  `max-evaluations` result is returned.

`FitResult` contains final `parameters`, objective `best_score`, `status`, evaluation
and iteration totals, `seed`, and per-iteration `FitTelemetry` with objective score,
improvement flag, cumulative evaluations, and step sizes. `to_json()` retains
`bestScore` for compatibility and adds the explicit `bestObjectiveScore` field.

`fit_against_divine_eye()` wraps `fit()` with a render callback, calls the Divine Eye
evaluator for each candidate, stores the raw results, and writes candidate metadata
back onto every evaluated record. Clean candidates keep their raw fidelity in the
`[0, 1]` range. Candidates with hard gates are scored as `-1.0` for the objective,
but their raw fidelity is still preserved separately as `bestRawFidelity` and in the
copied `divineEyeResults` / `correctionHistory` payloads.

## CLI Fixture Objective

The CLI only runs a deterministic quadratic fixture objective. Its top-level object
must contain exactly `initial`, `bounds`, `target`, and `config`; it reads:

```json
{
  "initial": [0.0],
  "bounds": [[-1.0, 1.0]],
  "target": [0.5],
  "config": {"maxIterations": 20, "maxEvaluations": 200, "seed": 7}
}
```

`config` accepts only `maxIterations`, `maxEvaluations`, `minImprovement`,
`plateauIterations`, `oscillationFlips`, and `seed`. Unknown keys are rejected with
exit status 2. Production callers use `fit()` directly with their own objective.

## Executable Divine Eye Fitting

`fit_against_divine_eye(initial, bounds, render_for_parameters, reference_png, evaluator=None, config=FitConfig())`
turns a deterministic parameter-to-render callback into a bounded fidelity objective.
For every evaluation it calls `render_for_parameters(parameters)`, evaluates the
render against `reference_png`, and maximizes a gate-aware objective score. Clean
results use their raw Divine Eye fidelity in `[0, 1]`; results with non-empty
`hardGateFailures` use `-1.0`, below every clean score. The raw fidelity is retained
unchanged in evaluator results and correction history, so all-gated runs remain
bounded and auditable without allowing a high raw gated score to displace a clean fit.

The optional evaluator receives `(reference_path, render_path)` and defaults to a
lazy import of `divine_eye.evaluate`, so importing the fitting module does not load
image-analysis dependencies. Its `DivineEyeFitResult` returns the `fit_result`, a
copied record of every evaluator result, and normalized `correction_history` with
hard gates and full Divine Eye provenance. The integration does not mutate evaluator
result mappings. Each copied result receives adapter-owned `fitCandidateParameters`,
`fitReferencePng`, and `fitRenderPath` fields.

`DivineEyeFitResult.fit_result.best_score` and `bestObjectiveScore` are objective
scores, not necessarily raw fidelity: an all-gated run reports `-1.0`. Use optional
`best_raw_fidelity` / JSON `bestRawFidelity` for the selected clean candidate. Its
`correction_history` / JSON `correctionHistory` is derived from raw copied Divine Eye
records, never objective scores, so it remains valid and auditable for all-gated runs.

## Divine Eye And Correction Loop

`divine_eye_fidelity(result)` reads the original Divine Eye `fidelity` as a scalar
objective score only when it is finite and within `[0, 1]`. `divine_eye_correction_history(results)` retains each result's
`hardGateFailures` and copies the same values into correction-loop `defectTags`.
Each normalized record also has a deep-copied `divineEye` mapping with the original
result context, including fidelity, gate failures, action, signals, and reference or
render paths when present. A result is approved only when it has no hard gates and
its present routing fields are `action="continue"` and `verdict="pass"`; fidelity-only
mappings remain approved for compatibility. A fidelity decrease from the last
approved best score records `reverted=True`; pending (`probe`/non-pass), reverted,
or hard-gated attempts do not replace that baseline or win gate-aware fitting.
Neither the source mapping nor its nested provenance is mutated.

`correction_loop.decide()` is the stop policy. It checks, in order, hard gates,
pending review routing, success, repeated defects, oscillation, plateau, and the
hard ceiling. That order matters, because a hard gate always routes to `refine-code`
and the ceiling always stops the loop even if the score is still climbing.

When correction history contains nested `divineEye` provenance, its finite fidelity,
hard gates, action, and verdict are authoritative. Mirrored top-level fidelity and
routing fields must match or validation rejects the entry; fidelity-only history
entries remain supported.

`budget_exceeded(spent_tokens, budget)` accepts a finite non-negative numeric spend
and a non-negative integer budget; malformed values raise `ValueError`.
