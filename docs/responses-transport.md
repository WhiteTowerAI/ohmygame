# Responses transport and recovery

OhMyGame keeps WebSocket as the default optimization for official OpenAI Responses
with either an API key or ChatGPT login. Persistent connections and incremental
inputs reduce overhead across successive tool calls. HTTP/SSE provides recovery
when the connection or proxy cannot sustain WebSocket.

## Provider choices

Model provider settings expose Responses connection for OpenAI and custom
Responses providers, inside the collapsed **Advanced** section near the end of
the provider page. Choices are saved with other provider preferences in
`model-visibility.json` under `responsesTransports`, and apply to the next model
request in existing sessions. Provider deletion uses the same transaction as
other provider preferences; no separate transport settings file needs cleanup.
Invalid optional transport preferences are ignored on load without discarding
other provider settings. Invalid modes are still rejected when saving through the API.

| Choice           | Behavior                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Automatic        | Prefer WebSocket for `https://api.openai.com/v1/responses`; use SSE for other endpoints. |
| HTTP / SSE       | Use HTTP streaming, including on official OpenAI.                                        |
| Prefer WebSocket | Try WebSocket for the provider's Responses endpoint, retaining SSE recovery.             |

Pi's explicit SSE setting is honored. Chat Completions and other APIs retain their
existing transports. A relay must be configured with the Responses API to use
this WebSocket path; the model name alone does not select transport.
WebSocket URLs and headers derive from the actual request endpoint and credentials.
Official Files capabilities are restricted to the exact official endpoint.
Relay requests that select SSE keep the existing inline-image fetch path,
including redirect behavior and forwarding encoded request bodies. Only relays
that select WebSocket enter the session transport and its SSE recovery path.

## Failure handling

- Connection failure before response events: retry the full request over SSE in
  the same call. Pause WebSocket attempts for five minutes.
- Disconnect, network error, malformed event or idle timeout after events begin:
  discard connection-local continuation and let Pi schedule an automatic retry.
  Show the existing Reconnecting row; the retry uses SSE during the cooldown.
- Provider server failures: preserve the provider error for Pi's normal retry
  decision. Switching protocols does not resolve an upstream server failure.
- Authentication, permission, quota and invalid requests: preserve rejection
  details and avoid treating them as transport incompatibility. They do not gain
  retries from misleading error wording.
- Cancellation: close the active socket or cancel retry backoff immediately.
- Successful recovery: clear the retry activity. Exhausted retries retain the
  final attempt's diagnostics, transport and retry count.

Pi's existing defaults allow three retries with exponential delays of approximately
2, 4 and 8 seconds; configured retry settings remain authoritative. Retry-disabled
sessions still fall back before streaming, but do not replay failed partial replies.
After the five-minute cooldown, a subsequent request may try a fresh WebSocket.
Endpoint, credentials and network dispatcher changes also require a fresh connection.

Recovery restarts the failed model response using the required conversation history.
It does not resume that response at its last token, so regenerated text can differ
and the interrupted request may still incur usage. Pi omits the failed partial
assistant attempt from model input and does not execute its tool calls. Previously
completed tool results remain in history. This is not a general exactly-once
guarantee for tools the model may choose to request again.

## Validation

Transport tests cover actual local Undici handshake rejection, relay isolation,
cooldown expiry, full-history retry, continuation invalidation and cancellation.
Pi integration tests exercise Reconnecting, SSE recovery, retry exhaustion,
provider rejections and tool execution. Settings tests cover persistence, restart,
deletion, live session changes and failed UI saves. Fixtures run locally without
calling paid model APIs. See [agent errors](agent-errors.md) for diagnostic details
and [image history](model-image-history.md) for payload budgets.

[Official OpenAI WebSocket documentation](https://developers.openai.com/api/docs/guides/websocket-mode)
describes connection-local state, continuation and reconnection behavior.
