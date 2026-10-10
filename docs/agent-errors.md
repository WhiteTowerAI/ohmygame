# Agent request errors

Model request failures carry a short, actionable explanation and expandable
diagnostics in the chat timeline. Authentication, account limits, request
compatibility, provider server errors, DNS, TLS, timeouts and interrupted responses
have distinct presentations. Unknown failures remain explicitly unclassified.

The details can be copied and include the provider, model, endpoint, HTTP status,
provider request ID, available underlying error codes and causes, and the number
of agent retries in the turn. Missing fields are omitted. The network field is
the active startup configuration from the network settings service, including
whether it uses an environment, system or manual proxy, or direct connections.
Saved changes that require a restart do not replace that active snapshot. The
field does not prove whether a particular request bypassed the proxy or how a
VPN routed it.

The application converts Pi messages and thrown errors into the same
`ThreadItemError` directly. Only the daemon classifies failures; the renderer
maps its code to a title and guidance. Structured HTTP status takes precedence
over generic wording, with explicit quota codes distinguished from rate limits.
Transport classification uses the saved cause codes, names and messages, so SDKs
without native error codes still give useful diagnostics.

## Pi compatibility patch

The pinned `@earendil-works/pi-ai@0.99.2` loses nested connection causes when it
converts SDK errors into `AssistantMessage.errorMessage`. For example, the OpenAI
SDK wraps DNS and TLS failures alike as `Connection error.`. The Bun patch in
`patches/@earendil-works%2Fpi-ai@0.99.2.patch` captures public error metadata in Pi's
existing `AssistantMessage.diagnostics` before conversion.

The patch covers the OpenAI completions and Responses adapters (including Codex
and Azure), Anthropic, Google Generative AI and Vertex, and System One. Existing
Bedrock failure metadata is also understood by the application. It does not
replace provider implementations, alter `errorMessage`, or change Pi's retry or
context recovery decisions. Context-compaction errors and third-party adapters
can still return only a message; those failures use the available message as a
fallback.

Cause traversal is bounded and handles aggregate errors and cycles. Only selected
error fields are saved; stack traces, request bodies and full headers are omitted.
Diagnostic text and URLs redact common credential forms, URL credentials, queries
and fragments through shared helpers. Codex HTTP retry diagnostics retain only
the current attempt's response metadata. Application-side normalization applies
the same public field allowlist when restoring a session.

Pi saves assistant diagnostics in its session JSONL. The application also records
the terminal error in an `ohmygame-agent-error` custom entry to preserve its
network configuration and retry count on reload. Live retries retain the latest
attempt's cause. Successful retries and user cancellation produce no terminal
error record. Failures before Pi records the user message get a separate history
item, so they cannot overwrite a previous turn's error. Terminal failures are
logged by the daemon with chat and turn IDs.

The terminal entry deliberately keeps a complete normalized error instead of
depending on mutable Pi messages or SDK persistence order. Normalization on
reload validates stored or imported session data as well as current messages.

## Maintenance and validation

`bun install --frozen-lockfile` applies the versioned dependency patch. When
upgrading Pi, check whether the new version preserves these fields before
removing or adapting the patch. Prefer an upstream implementation of the shared
failure diagnostic helper and adapter hooks over a permanent fork.

Run `test/provider-error-diagnostics.test.ts` to exercise real Pi adapters with
offline fetch fixtures, and the agent error, agent manager and timeline tests to
verify classification, redaction, retry completion and history restoration. The
same provider tests should pass after a clean dependency install. Desktop release
verification must confirm the patched helper and adapter hooks are present in
the packaged application's dependencies.
