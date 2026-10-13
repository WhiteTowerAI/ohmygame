import { describe, expect, it } from "vitest";
import { createProviderFailureDiagnostic } from "@earendil-works/pi-ai/utils/provider-failure";
import { assistantMessageError, normalizeAgentError, thrownAgentError } from "../src/daemon/agent-errors.js";
import { agentErrorDiagnosticText, agentErrorPresentation } from "../src/renderer/agent-error-presentation.js";
import type { ThreadItemErrorCode } from "../src/shared/contracts.js";

describe("agent error diagnostics", () => {
  it.each<[string, ThreadItemErrorCode]>([
    ["ENOTFOUND", "dns_error"], ["EAI_AGAIN", "dns_error"],
    ["ECONNREFUSED", "connection_refused"], ["ECONNRESET", "connection_reset"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout"], ["CERT_HAS_EXPIRED", "tls_error"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls_error"], ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_error"],
  ])("classifies a nested %s without guessing from the SDK wrapper", (code, expected) => {
    const cause = new TypeError("fetch failed", { cause: Object.assign(new Error("transport failure"), { code }) });
    const error = new Error("Connection error.", { cause });
    const result = thrownAgentError(error);
    expect(result.code).toBe(expected);
    expect(result.diagnostics?.causes).toContainEqual({ name: "Error", message: "transport failure", code });
  });

  it.each<[number, string, ThreadItemErrorCode]>([
    [400, "invalid_request_error", "invalid_request"], [401, "authentication_error", "authentication_failed"],
    [402, "insufficient_balance", "quota_exceeded"], [403, "permission_denied", "access_denied"],
    [404, "model_not_found", "model_unavailable"], [429, "rate_limit_error", "rate_limited"],
    [429, "insufficient_quota", "quota_exceeded"],
    [503, "service_unavailable", "provider_unavailable"],
  ])("classifies HTTP %s (%s) using provider metadata", (statusCode, errorCode, expected) => {
    expect(normalizeAgentError("Provider returned an error", { statusCode, errorCode }).code).toBe(expected);
  });

  it("reads legacy HTTP messages and keeps unknown errors honest", () => {
    expect(normalizeAgentError('401: {"message":"invalid key"}').code).toBe("authentication_failed");
    expect(normalizeAgentError("OpenAI API error (429): quota exceeded").code).toBe("quota_exceeded");
    const error = normalizeAgentError("Something unexpected happened");
    expect(error.code).toBeUndefined();
    expect(agentErrorPresentation(error).title).toBe("Model request failed");
  });

  it.each([
    ["self signed certificate", "tls_error"],
    ["getaddrinfo failed", "dns_error"],
    ["connection refused", "connection_refused"],
    ["connection timed out", "timeout"],
    ["socket hang up", "connection_reset"],
  ])("classifies an SDK cause with only the message %s", (message, code) => {
    expect(thrownAgentError(new Error("Connection error.", { cause: new Error(message) })).code).toBe(code);
  });

  it("uses HTTP evidence without mistaking numbers or request parameters for a failure category", () => {
    expect(normalizeAgentError("Request timed out after 401 seconds").code).toBe("timeout");
    expect(normalizeAgentError("Invalid parameter rate_limit", { statusCode: 400 }).code).toBe("invalid_request");
    expect(normalizeAgentError("Billing endpoint unavailable", { statusCode: 503 }).code).toBe("provider_unavailable");
    expect(normalizeAgentError("Server failed (503): unavailable").code).toBe("provider_unavailable");
  });

  it("handles a thrown SDK object directly without converting it to an assistant message", () => {
    expect(thrownAgentError({ message: "Authentication failed", status: 401 })).toMatchObject({ message: "Authentication failed", code: "authentication_failed" });
    const unreadable = new Error();
    Object.defineProperty(unreadable, "message", { get: () => { throw new Error("bad getter"); } });
    expect(thrownAgentError(unreadable).message).toBe("The model request failed");
  });

  it("does not persist request bodies, headers, stacks or secrets in public diagnostics", () => {
    const error = normalizeAgentError("fetch failed https://name:password@example.com/v1?api_key=query-secret Bearer bearer-secret api_key=literal-secret sk-secret123456", {
      endpoint: "https://name:password@example.com/v1?api_key=query-secret#fragment",
      requestId: "req-123",
      headers: { Authorization: "secret-header" },
      body: "private prompt",
      stack: "private stack",
      causes: [{ name: "TypeError", message: "password=proxy-secret", code: "ECONNREFUSED", stack: "private stack" }],
      network: { source: "manual", proxyUrl: "http://name:proxy-password@localhost:7890?token=proxy-token" },
    });
    const text = agentErrorDiagnosticText(error);
    for (const secret of ["password@example", "query-secret", "bearer-secret", "literal-secret", "sk-secret123456", "secret-header", "private prompt", "private stack", "proxy-secret", "proxy-password", "proxy-token"]) expect(text).not.toContain(secret);
    expect(error.diagnostics?.endpoint).toBe("https://example.com/v1");
    expect(error.diagnostics?.network?.proxyUrl).toBe("http://localhost:7890/");
    expect(text).toContain("req-123");
  });

  it("bounds malformed persisted diagnostics", () => {
    const result = normalizeAgentError("x".repeat(8_000), { statusCode: "401", endpoint: "javascript:alert(1)", causes: Array.from({ length: 30 }, () => ({ message: "x".repeat(2_000) })), retryAttempts: -1 });
    expect(result.message).toHaveLength(4_000);
    expect(result.diagnostics?.causes).toHaveLength(12);
    expect(result.diagnostics?.causes?.[0].message).toHaveLength(1_000);
    expect(result.diagnostics?.statusCode).toBeUndefined();
    expect(result.diagnostics?.endpoint).toBeUndefined();
    expect(result.diagnostics?.retryAttempts).toBeUndefined();
  });

  it("restores structured Pi diagnostics without changing the provider message", () => {
    const cause = new Error("Connection error.", { cause: Object.assign(new Error("getaddrinfo failed"), { code: "ENOTFOUND" }) });
    const message = { provider: "deepseek", model: "deepseek-chat", errorMessage: "Connection error.", diagnostics: [createProviderFailureDiagnostic(cause, "https://api.deepseek.com")] };
    const error = assistantMessageError(JSON.parse(JSON.stringify(message)));
    expect(error).toMatchObject({ message: "Connection error.", code: "dns_error", diagnostics: { provider: "deepseek", model: "deepseek-chat", endpoint: "https://api.deepseek.com/" } });
    expect(agentErrorDiagnosticText(error)).toContain("ENOTFOUND");
  });
});
