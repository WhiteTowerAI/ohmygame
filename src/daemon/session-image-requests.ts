import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { getDeclaredTools, normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { isDeepSeekFileModel } from "./deepseek-image-files.js";
import { isOfficialOpenAIResponses, OpenAISessionTransport } from "./openai-session-transport.js";
import { OpenAISessionFiles } from "./openai-session-files.js";
import { SessionImages, localImageError, ImageBudgetError, MODEL_REQUEST_HIGH_BYTES } from "./session-images.js";

// These Pi adapters send through options.fetch. Other SDKs need the onPayload guard;
// Google's adapters explicitly reject a custom fetch, and Bedrock ignores it.
const FETCH_APIS = new Set([
  "openai-responses", "openai-completions", "openai-codex-responses", "azure-openai-responses",
  "anthropic-messages", "pi-messages", "mistral-conversations",
]);
const ASSISTANT_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

/** Reapply persisted decisions on HTTP retries and shrink a 413 at most once. */
function wrapInlineImageFetch(delegate: typeof fetch, images: SessionImages): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, init);
    if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) return delegate(request);
    if (request.headers.has("content-encoding")) {
      const body = await request.clone().arrayBuffer();
      return body.byteLength > MODEL_REQUEST_HIGH_BYTES ? localImageError(new ImageBudgetError()) : delegate(request);
    }
    const body = await request.clone().text();
    const payload: unknown = JSON.parse(body);
    try { images.budget(payload, "inline"); }
    catch (error) { if (error instanceof ImageBudgetError) return localImageError(error); throw error; }
    const headers = new Headers(request.headers); headers.delete("content-length");
    request = new Request(request, { headers, body: JSON.stringify(payload) });
    const response = await delegate(request);
    if (response.status !== 413) return response;
    request.signal.throwIfAborted();
    try {
      images.budget(payload, "inline", true);
      await response.body?.cancel();
      const reduced = await delegate(new Request(request, { body: JSON.stringify(payload), redirect: "error" }));
      if (reduced.status !== 413) return reduced;
      const finalHeaders = new Headers(reduced.headers); finalHeaders.set("x-should-retry", "false");
      return new Response(reduced.body, { status: reduced.status, statusText: reduced.statusText, headers: finalHeaders });
    } catch (error) {
      request.signal.throwIfAborted();
      if (!(error instanceof ImageBudgetError)) throw error;
      await response.body?.cancel(); return localImageError(error);
    }
  };
}

/** Install outside Pi's extension runner: preparation failures must stop the provider request. */
export function installSessionImageRequests(session: AgentSession, images: SessionImages, agentDir: string,
  transport = new OpenAISessionTransport(images, new OpenAISessionFiles(path.join(agentDir, "openai-image-files")))): void {
  const lifetime = new AbortController();
  let activeOpenAIRequest = false;
  const stream = session.agent.streamFunction;
  const dispose = session.dispose.bind(session);
  session.dispose = () => { lifetime.abort(new Error("Session disposed")); transport.dispose(); dispose(); };
  const warmingMode = session.settingsManager.getCacheWarmingMode.bind(session.settingsManager);
  // A warming response would advance the connection-local lineage independently of the agent.
  // WS already retains request state; suppress full-history background replay on this route.
  session.settingsManager.getCacheWarmingMode = () => activeOpenAIRequest || session.model?.api === "openai-responses"
    && isOfficialOpenAIResponses(`${session.model.baseUrl.replace(/\/$/, "")}/responses`) ? "off" : warmingMode();
  session.agent.streamFunction = async (model, context, options) => {
    options = { ...options, signal: options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal };
    const openai = model.api === "openai-responses" && isOfficialOpenAIResponses(`${model.baseUrl.replace(/\/$/, "")}/responses`);
    activeOpenAIRequest = openai;
    if (isDeepSeekFileModel(model)) return stream(model, context, options);
    const prepared = await images.prepare(context, model, session.settingsManager.getImageAutoResize());
    const delegate = options?.fetch ?? globalThis.fetch;
    const fetch = openai ? transport.wrapFetch(delegate, {
      transport: options?.transport,
      cacheRetention: options?.cacheRetention,
      connectTimeoutMs: options?.websocketConnectTimeoutMs ?? session.settingsManager.getWebSocketConnectTimeoutMs(),
      timeoutMs: options?.timeoutMs ?? session.settingsManager.getProviderRetrySettings().timeoutMs ?? session.settingsManager.getHttpIdleTimeoutMs(),
    }) : FETCH_APIS.has(model.api) ? wrapInlineImageFetch(delegate, images) : options?.fetch;
    // Legacy Codex may use a native WebSocket without fetch. Keep its conservative
    // full-input check; normal HTTP adapters only budget at the final boundary.
    const onPayload = !openai && (!FETCH_APIS.has(model.api) || model.api === "openai-codex-responses")
      ? async (payload: unknown, requestModel: typeof model) => {
        const replacement = await options?.onPayload?.(payload, requestModel);
        const final = replacement ?? payload;
        images.budget(final, "inline"); return final;
      } : options?.onPayload;
    const events = await stream(model, prepared, {
      ...options, fetch, onPayload,
    });
    if (openai) {
      // Use exactly Pi's assistant serialization, including signatures, IDs and grammar tools.
      // Only a successfully parsed terminal message becomes a continuation baseline.
      void events.result().then((message) => {
        if (message.stopReason === "error" || message.stopReason === "aborted") { transport.dispose(); return; }
        const output = convertResponsesMessages(model, normalizeContext({ messages: [message] }), ASSISTANT_PROVIDERS, {
          includeSystemPrompt: false,
          grammarToolInputProperties: createGrammarToolInputProperties(getDeclaredTools(prepared.messages), model.compat && "supportsOpenAIGrammarTools" in model.compat ? model.compat.supportsOpenAIGrammarTools ?? false : false),
        });
        transport.complete(message.responseId, output);
      }).catch(() => transport.dispose());
    }
    return events;
  };
}
