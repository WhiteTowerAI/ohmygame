# Free cloud models

Free connections belong to the OhMyGame account. They use the trusted Cloud API
configured by `CLOUD_API_URL`, independently of the user's provider credentials
and the paid account wallet. Hyper3D is the first integration (`cloud-hyper3d`,
model `rodin`); users keep their existing default models and provider preferences.

The desktop offers free access before sign-in. Hyper3D has one settings entry
in **Free cloud**, with account sign-in, daily credits, and an optional API key on one page. A verified Supabase
session activates the connection automatically. Its access token stays in daemon
memory, is refreshed from product auth, and is removed on sign-out. Local debug
sign-in does not authorize free cloud generation. Provider keys are never sent
to the desktop, project files, the agent, or model inputs.

Providers show the user's remaining daily allowance. The detail page shows
personal credits and platform shared generation counts with compact progress bars and reset time. Models remain selectable when exhausted; their generation action
is temporarily unavailable. Cancelling desktop waiting keeps the remote job;
successful results are saved to Library through the normal generation flow. The server retains remote jobs for reconciliation, including when desktop waiting is cancelled.

Free cloud models use the common model list's search and visibility controls.
Users can hide models or select defaults; the server owns the permitted catalog
and generation options. Hyper3D reports its configured Rodin generation and
quality in the catalog, keeping `rodin` as the stable model ID. Neither the
provider key nor an editable tier is returned to desktop clients.

The Canvas generation entry shows remaining daily credits, estimated cost, one
progress bar, and a line for reset time/shared allowance. Held credits appear
when a submission is pending. The server checks the allowance again on submission.

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

The platform shared pool is a configured allocation, not an upstream balance
claim. Hyper3D's `check_balance` reports credits and does not document remaining
daily free model requests. Unknown allowances are displayed as unavailable.

## Cloud configuration

In `ohmygame-cloud`, apply
`database/migrations/20261010000000_create_cloud_model_quotas.sql` and then
`database/migrations/20261010010000_meter_cloud_credits.sql` to Supabase and
configure the server as described in its `docs/free-cloud-models.md`. The key,
permitted tier, confirmed pool allowance and concurrency limit belong exclusively
to that service. Each account defaults to **20 credits/day**, configurable through
`HYPER3D_USER_DAILY_CREDITS`. The old `HYPER3D_USER_DAILY_LIMIT` is no longer read.
Gen 1/1.5/2/2.5 basic generation costs 0.5 credits (up to 40 at the default allowance);
Gen 2.5 Extreme High costs 1. Shared pool exhaustion can stop generation earlier.
The server reserves the estimated cost, then settles confirmed `consumed` credits;
if billing is absent it retains the estimate. The new migration preserves historical
usage and pending reservations rather than resetting today's allowance.
The integration stays unavailable until required settings exist.
No generation or paid fallback happens during configuration.

## Extending the foundation

The catalog and quota contracts in `src/shared/cloud-models.ts` mirror
`ohmygame-cloud/packages/contracts/src/cloud-models.ts`. Keep their changes in
sync. Capabilities and quota units include language/image/video/3D and
requests/tokens/images/models/credits. Personal and shared balances can use
different units. The cloud owns admission, durable jobs, atomic
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
