# Free cloud models

Free connections belong to the OhMyGame account. They use the trusted Cloud API
configured by `CLOUD_API_URL`, independently of the user's provider credentials
and the paid account wallet. Hyper3D is the first integration (`cloud-hyper3d`),
with all ten Rodin tiers. Existing default models and provider preferences are kept.

The desktop offers free access before sign-in. Hyper3D has one settings entry
in **Free cloud**, with account sign-in, daily credits, and an optional API key on one page. A verified Supabase
session activates the connection automatically. Its access token stays in daemon
memory, is refreshed from product auth, and is removed on sign-out. Local debug
sign-in does not authorize free cloud generation. Provider keys are never sent
to the desktop, project files, the agent, or model inputs.

Providers show the user's remaining daily allowance. The detail page shows
personal credits with one compact progress bar and reset time. Models remain selectable when exhausted; their generation action
is temporarily unavailable. Cancelling desktop waiting keeps the remote job;
successful results are saved to Library through the normal generation flow. The server retains remote jobs for reconciliation, including when desktop waiting is cancelled.

Free cloud models use the common model list's search and visibility controls.
Users can hide models or select defaults; the server owns the permitted catalog
and generation options. Both allowance sources include all ten documented tiers,
using their tier IDs as model IDs, with Gen 2.5 Medium as the free default.
Saved `rodin` references resolve to Medium without adding a duplicate catalog entry.
The shared key stays on the server; users choose a tier through the model picker.

The Canvas generation entry shows remaining daily credits, estimated cost, one
progress bar, and a line for reset time. Held credits appear
when a submission is pending. Each model row includes its credit price. The
generation action also checks the selected model's cost: 0.5 credits remaining
allows a basic tier but disables Extreme High with a suggestion to choose a
cheaper tier. The server checks the allowance again on submission.

Within **Hyper3D** settings, **Your API key** accepts a user's own key and runs
through the local daemon, without OhMyGame sign-in or free-cloud limits.
**Free account credits** uses the account's daily allocation. Both connections
can be configured at the same time. One Hyper3D switch enables or disables both sources;
the combined model list labels **Free account** and **Your API key**, with independent visibility and defaults.
Removing an API key only removes that saved key connection and its model settings.
The generation picker labels the sources **Hyper3D · Free** and **Hyper3D · API key**. Neither connection silently falls back to the other. Own-key models
support editing defaults, visibility, and adding model/tier IDs. Their advertised
cost is an estimate; Hyper3D determines actual billing and key access.

Rodin accepts one to five PNG/JPEG references with no required direction order.
Canvas labels them **Reference 1…5**, showing supplied images and the next slot.
Tripo keeps its protocol's **Front / Left / Back / Right** order. Meshy uses
neutral reference labels and the selected version's image limit.

Hyper3D's `check_balance` reports upstream credits and does not document remaining
daily free model requests. The desktop displays only the account's daily allocation;
there is no platform daily quota. Unknown personal allowances are displayed as unavailable.

## Cloud configuration

In `ohmygame-cloud`, apply
`database/migrations/20261010000000_create_cloud_model_quotas.sql`,
`database/migrations/20261010010000_meter_cloud_credits.sql`, then
`database/migrations/20261010020000_fix_cloud_credit_allocation.sql` to Supabase and
configure the server as described in its `docs/free-cloud-models.md`. The key,
personal allocation and provider concurrency limit belong exclusively
to that service. Each account defaults to **20 credits/day**, configurable through
`HYPER3D_USER_DAILY_CREDITS`. The old `HYPER3D_USER_DAILY_LIMIT` is no longer read.
Gen 1/1.5/2/2.5 basic generation costs 0.5 credits (up to 40 at the default allowance);
Gen 2.5 Extreme High costs 1. Hyper3D still enforces the key's upstream limits.
The server reserves and charges the selected catalog price to the daily allocation;
upstream `consumed` is stored independently for audit. A grant returning zero
consumption still uses the account's daily credits. The migrations preserve
historical usage and pending reservations. `HYPER3D_TIER` is no longer read;
clients select the tier through `modelId`. Key permissions still depend on Hyper3D;
a definite rejection releases the full hold.
Configuring `HYPER3D_API_KEY` enables generation with the default personal credits
and concurrency limits. `HYPER3D_POOL_DAILY_LIMIT` is no longer read.
This removal requires no additional database migration. Historical pool counters
are ignored for new jobs; existing jobs still settle their stored reservations.
No generation or paid fallback happens during configuration.

## Extending the foundation

The catalog and quota contracts in `src/shared/cloud-models.ts` mirror
`ohmygame-cloud/packages/contracts/src/cloud-models.ts`. Keep their changes in
sync. Capabilities and quota units include language/image/video/3D and
requests/tokens/images/models/credits. Quota responses contain only `personal`,
using the top-level quota unit; `pool` and `pool_exhausted` have been removed.
Update desktop clients before deploying the matching cloud API, since older
desktop versions require the removed field. The cloud owns admission, durable jobs, atomic
reservations, reconciliation and credentials. Execution remains capability
specific: future LLMs need streaming and token settlement, image models need
their own adapter and result format. Those providers have not been configured
or implemented by this change.

Both manual and agent 3D tools use `ProviderModels3D` and the same authenticated
cloud endpoint. The server checks quota again for every request; the displayed
balance is informational. Retries use the same idempotency key so a lost response
does not create a second upstream task.

## Validation

Run `bun run typecheck`, `bun run test -- test/cloud-models.test.ts` and the
existing provider/tool tests. Cloud tests execute the production migration and
quota functions inside PGlite PostgreSQL. A staging Supabase and live Hyper3D
test remain necessary before release to validate the real grant's tier, limits,
upstream behavior and multi-instance database locking.
