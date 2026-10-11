import { stream as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { createProviderFailureDiagnostic } from "@earendil-works/pi-ai/utils/provider-failure";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import { assistantMessageError } from "../src/daemon/agent-errors.js";

const model = Object.values(DEEPSEEK_MODELS)[0];
const context = normalizeContext({ messages: [{ role: "user", content: [{ type: "text", text: "probe" }], timestamp: 1 }] });

describe("patched Pi provider failures", () => {
  it.each(["ENOTFOUND", "ECONNREFUSED", "CERT_HAS_EXPIRED", "ECONNRESET"])("preserves %s through the actual DeepSeek adapter", async (code) => {
    const cause = new TypeError("fetch failed", { cause: Object.assign(new Error(`Synthetic ${code}`), { code }) });
    const message = await completions(model, context, { apiKey: "test-only", maxRetries: 0, fetch: async () => { throw cause; } }).result();
    expect(message.errorMessage).toBe("Connection error.");
    expect(isRetryableAssistantError(message)).toBe(true);
    expect(assistantMessageError(message).diagnostics?.causes).toContainEqual({ name: "Error", message: `Synthetic ${code}`, code });
  });

  it("captures HTTP metadata and leaves quota retry decisions unchanged", async () => {
    const message = await completions(model, context, { apiKey: "test-only", fetch: async () => new Response(JSON.stringify({ error: { message: "Quota exceeded", code: "insufficient_quota" } }), { status: 429, headers: { "content-type": "application/json", "x-request-id": "req-test" } }) }).result();
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(assistantMessageError(message)).toMatchObject({ code: "quota_exceeded", diagnostics: { statusCode: 429, requestId: "req-test", errorCode: "insufficient_quota" } });
  });

  it("captures stream failures after a successful HTTP response", async () => {
    const message = await completions(model, context, { apiKey: "test-only", fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream", "x-request-id": "req-stream" } }) }).result();
    expect(message.errorMessage).toBe("Stream ended without finish_reason");
    expect(assistantMessageError(message)).toMatchObject({ code: "stream_error", diagnostics: { statusCode: 200, requestId: "req-stream" } });
  });

  it("also preserves connection causes in the Responses adapter", async () => {
    const responseModel = { ...model, api: "openai-responses" as const, provider: "openai", baseUrl: "https://example.invalid/v1" };
    const message = await responses(responseModel, context, { apiKey: "test-only", fetch: async () => { throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }); } }).result();
    expect(assistantMessageError(message).code).toBe("connection_refused");
  });

  it("also preserves connection causes in the Anthropic adapter", async () => {
    const anthropicModel = { ...model, compat: undefined, api: "anthropic-messages" as const, provider: "anthropic", baseUrl: "https://example.invalid" };
    const message = await anthropic(anthropicModel, context, { apiKey: "test-only", fetch: async () => { throw Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }); } }).result();
    expect(assistantMessageError(message).code).toBe("dns_error");
  });

  it("does not attach a previous Codex HTTP response to the next attempt's network failure", async () => {
    const apiKey = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }))}.test`;
    let attempts = 0;
    const message = await codex({ ...model, api: "openai-codex-responses", provider: "openai-codex" }, context, {
      apiKey, transport: "sse", maxRetries: 1, fetch: async () => {
        if (attempts++ === 0) return new Response("Server busy", { status: 503, headers: { "retry-after": "0.001", "x-request-id": "previous-request" } });
        throw Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
      },
    }).result();
    expect(attempts).toBe(2);
    const error = assistantMessageError(message);
    expect(error.code).toBe("dns_error");
    expect(error.diagnostics?.statusCode).toBeUndefined();
    expect(error.diagnostics?.requestId).toBeUndefined();
  });

  it("handles aggregate causes, cycles and throwing getters without losing the error", () => {
    const cycle = Object.assign(new Error("nested"), { code: "ECONNREFUSED" }) as Error & { cause?: unknown };
    const error = new AggregateError([cycle, new Error("second")], "connection failed");
    cycle.cause = error;
    Object.defineProperty(error, "headers", { get: () => { throw new Error("bad getter"); } });
    const diagnostic = createProviderFailureDiagnostic(error);
    expect((diagnostic.details?.causes as unknown[])).toHaveLength(2);
    expect(JSON.stringify(diagnostic)).not.toContain("stack");
    expect(assistantMessageError({ errorMessage: "Connection error.", diagnostics: [diagnostic] }).code).toBe("connection_refused");
  });

  it("bounds traversal even when nested aggregate entries have no error fields", () => {
    let visited = 0;
    function emptyAggregate(): object {
      return { get errors() { visited++; return Array.from({ length: 12 }, emptyAggregate); } };
    }
    expect(createProviderFailureDiagnostic(emptyAggregate()).error?.message).toBe("The model request failed");
    expect(visited).toBeLessThan(100);
  });
});
