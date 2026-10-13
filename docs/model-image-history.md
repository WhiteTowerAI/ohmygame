# Model image history

OhMyGame retains images in the Pi conversation transcript. Model requests use a
separate projection; neither the transcript nor the conversation UI is rewritten.
The stored session can therefore remain large. This feature bounds transmission;
it does not migrate historical image bytes out of the session file.
This addresses [#187](https://github.com/WhiteTowerAI/ohmygame/issues/187), where
repeated screenshots made requests tens of megabytes larger on every turn.

## Request policies

| Route | Transport and images |
| --- | --- |
| Official OpenAI Responses, ChatGPT subscription | WebSocket with connection-local incremental input; budgeted full replay on reconnect or HTTP/SSE fallback. No Files API probe. |
| Official OpenAI Responses, Platform API key | The same WebSocket transport plus cached vision file uploads. Bounded inline fallback when uploads are unavailable. |
| Official DeepSeek | The existing original-image Files adapter and its limits are preserved. No preview conversion or generic image omission. |
| Other providers and custom compatible endpoints | Budgeted inline images through Pi's existing adapter. OpenAI-specific capabilities are not assumed. |
| Legacy OpenAI Codex | Pi's existing transport, with conservative full-input budgeting before it chooses a WebSocket delta. |

The official OpenAI route is exactly `https://api.openai.com/v1/responses`.
Network proxies remain supported through the application's Undici dispatcher;
changing the dispatcher or credentials invalidates the connection and continuation.
Pi's `sse` transport setting is honored; plain `websocket` and `cacheRetention: none`
disable incremental context reuse. WebSocket failures before any response
event allow HTTP fallback, with a five-minute backoff before probing WebSocket
again. Once events have reached Pi, interrupted inference fails without automatic
replay. Tool execution remains owned by Pi.
Stream failures preserve their original cause in diagnostics and use a nonretryable
assistant error message, since Pi's outer session retry policy matches error text.

## Inline budgets and recovery

These are application defaults, not advertised provider limits:

- Trigger image omission above 20 MiB of Base64 or 64 inline images.
- Remove a batch toward 10 MiB and 32 images, prioritizing old `game_use` images.
- The lower limits are cleanup targets. Protected images may keep a reduced request
  above them, as long as the 20 MiB / 64-image hard limits still hold.
- Protect images in the latest user message and the two most recent image-bearing
  observations. If protected images alone cannot fit, fail locally.
- Limit the complete serialized request to 32 MiB, including text and JSON.

For OpenAI, the image budget is evaluated after Files conversion or WebSocket
delta extraction. Historical file references do not consume the inline budget.
Model vision tokens still count toward context usage; Pi's existing context
compaction remains responsible for that separate limit.

An omission is a branch-local custom session entry (`ohmygame-image-offload-v1`),
scoped to the inline policy and identified by source entry ID and image occurrence.
Identical bytes appearing again are a new occurrence. Original bytes are never
duplicated in omission entries. Compaction and restart preserve the decisions for
images that remain in the active context. Branch navigation applies that branch's
decisions. Files routes can retain images omitted under an inline policy.

Placeholders include an image ID usable with the read-only `recall_image` tool.
The tool reads the original from the current conversation branch, independently
of the disposable UI media cache. Its result becomes a new image occurrence.

Occurrence mapping follows Pi's wire layouts: merged Responses tool text,
Completions/Gemini tool images promoted to user turns, and Gemini 3 images inside
`functionResponse.parts`. Gemini 3 omissions are added to the function response's
text output; its image-only parts are removed instead of receiving invalid text parts.

PNG screenshots and opaque `read` images above 256 KiB Base64 receive a cached
JPEG quality-80 request preview when it is smaller. This also applies to old
conversation images. Pixel dimensions are preserved, including the coordinate
relationship in existing screenshot metadata. Read images with alpha channels
or palette transparency remain PNG, and disabling Pi's image auto-resize disables
read previews. User attachments and recalled originals keep their encoding.
Preview identity includes the original content and codec policy version, so
repeated requests have a stable prefix. A single Photon codec handles screenshot
and read previews; Sharp remains a development-only fixture dependency.
[#201](https://github.com/WhiteTowerAI/ohmygame/pull/201) supplies shared format
detection and correct generated filenames without re-encoding canonical reads.

## OpenAI continuation and Files lifecycle

Pi continues to build payloads, resolve credentials and parse Responses events.
The transport converts native WebSocket events to the SSE stream expected by the
existing adapter. After successful Pi parsing, its own assistant serializer
establishes the next continuation prefix, preserving reasoning signatures and
tool IDs. Continuation stores the prefix length and SHA-256 digest, rather than
retaining another full historical image payload. Edited history, changed tools/model, compaction and image omission
cannot reuse a mismatched prefix. A missing response ID gets one fresh replay.
Connections rotate after 55 minutes and close after two idle minutes or disposal.
OpenAI background cache warming is disabled to avoid independently advancing the
connection-local conversation or replaying large historical inputs.

Only Platform API keys (`sk-`) can use the official Files route. Vision files are
requested with a seven-day expiration, cached by credentials, organization,
project and image content/type, and verified after five minutes. Uploads have a
120-second timeout, at most four concurrent workers, and shared pending work with
per-caller cancellation. Explicit missing/expired file errors invalidate the
matching cache generation and get one recovery attempt. Unrelated provider errors
are returned unchanged. Failed uploads back off for five minutes; fallback still
has to fit the inline budget.

File references are committed to the request only after every upload succeeds,
so partial failure needs no additional full-payload clone for inline fallback.

HTTP 413 and WebSocket 1009 trigger at most one additional image reduction, which
must remove an image before another inference request is sent. They never retry
an unchanged oversized payload or blindly switch that payload to HTTP. Budget
checks run outside Pi's error-swallowing extension hooks. HTTP adapters check at
the final request boundary; Google and other SDKs without custom-fetch support
check after the payload callback instead. Legacy Codex also checks before its
native WebSocket path. Extensions that add untracked oversized images cannot
bypass the guard. Normal HTTP requests do not repeat the same budget in both hooks.

## Validation

`test/session-images.test.ts` covers byte/count thresholds, canonical preservation,
branch and occurrence identity, recall, custom and Bedrock binary images, stable previews and DeepSeek
exemption. `test/openai-session-files.test.ts` covers persistent credential/project
isolation, verification, stale IDs, concurrent upload cancellation and fallback.
`test/openai-session-transport.test.ts` covers delta input, reconnection, missing IDs,
pre/post-stream failures, 1009, explicit SSE, custom endpoints and cancellation.
`test/session-image-requests.test.ts` exercises actual Pi session serialization and
stream parsing against a fake WebSocket, plus final extension-payload enforcement.
It also checks Google's payload guards and that normal HTTP budgeting runs once
per send or deliberate size-recovery attempt.

Tests use synthetic providers and local fixtures. They do not spend model credits
or establish successful live subscription/API inference. Release verification
should also exercise the user's real proxy and account with continuous captures,
then disconnect/reconnect and resume the conversation.

Official contracts:

- [ChatGPT plan usage limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
