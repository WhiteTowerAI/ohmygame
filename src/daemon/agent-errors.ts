import { createProviderFailureDiagnostic, sanitizeDiagnosticText, sanitizeDiagnosticUrl } from "@earendil-works/pi-ai/utils/provider-failure";
import type { AgentErrorCause, AgentErrorDiagnostics, ThreadItemError, ThreadItemErrorCode } from "../shared/contracts.js";

export const AGENT_ERROR_ENTRY = "ohmygame-agent-error";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Keep only public diagnostic fields; SDK bodies, headers and stacks stay out. */
export function normalizeAgentError(message: string, input?: unknown): ThreadItemError {
  const source = record(input) ?? {};
  const diagnostics: AgentErrorDiagnostics = {};
  for (const key of ["provider", "model", "requestId", "errorCode"] as const) {
    const value = sanitizeDiagnosticText(source[key], 200);
    if (value) diagnostics[key] = value;
  }
  const endpoint = sanitizeDiagnosticUrl(source.endpoint);
  if (endpoint) diagnostics.endpoint = endpoint;
  if (typeof source.statusCode === "number" && Number.isInteger(source.statusCode) && source.statusCode >= 100 && source.statusCode <= 599) diagnostics.statusCode = source.statusCode;
  if (typeof source.retryAttempts === "number" && Number.isInteger(source.retryAttempts) && source.retryAttempts >= 0) diagnostics.retryAttempts = source.retryAttempts;
  if (Array.isArray(source.causes)) {
    const causes: AgentErrorCause[] = source.causes.slice(0, 12).flatMap((value) => {
      const entry = record(value);
      if (!entry) return [];
      const cause: AgentErrorCause = {};
      for (const key of ["name", "message", "code"] as const) {
        const text = sanitizeDiagnosticText(entry[key], key === "message" ? 1_000 : 100);
        if (text) cause[key] = text;
      }
      return Object.keys(cause).length ? [cause] : [];
    });
    if (causes.length) diagnostics.causes = causes;
  }
  const network = record(source.network);
  if (network && ["environment", "system", "manual", "direct"].includes(String(network.source))) {
    const proxyUrl = sanitizeDiagnosticUrl(network.proxyUrl);
    diagnostics.network = { source: network.source as NonNullable<AgentErrorDiagnostics["network"]>["source"], ...(proxyUrl ? { proxyUrl } : {}) };
  }
  const text = sanitizeDiagnosticText(message, 4_000) || "The model request failed";
  const code = classifyAgentError(text, diagnostics);
  return { message: text, ...(code ? { code } : {}), ...(Object.keys(diagnostics).length ? { diagnostics } : {}) };
}

/** Works with both live Pi messages and messages restored from session JSONL. */
export function assistantMessageError(value: unknown): ThreadItemError {
  const message = record(value) ?? {};
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  const failure = diagnostics.findLast((value) => ["provider_failure", "bedrock_response_failure"].includes(String(record(value)?.type)));
  return normalizeAgentError(typeof message.errorMessage === "string" ? message.errorMessage : "The model request failed", {
    provider: message.provider,
    model: message.model,
    ...providerFailureFields(failure),
  });
}

function providerFailureFields(failure: unknown): Record<string, unknown> {
  const diagnostic = record(failure);
  const details = record(diagnostic?.details) ?? {};
  const error = record(diagnostic?.error);
  const causes = Array.isArray(details.causes) ? details.causes : [];
  return {
    endpoint: details.endpoint,
    statusCode: details.status,
    requestId: details.requestId,
    errorCode: details.errorCode ?? error?.code,
    causes: error ? [error, ...causes] : causes,
  };
}

export function thrownAgentError(cause: unknown): ThreadItemError {
  const diagnostic = createProviderFailureDiagnostic(cause);
  const message = typeof cause === "string" ? cause : diagnostic.error?.message ?? "The model request failed";
  return normalizeAgentError(message, providerFailureFields(diagnostic));
}

function classifyAgentError(message: string, diagnostics: AgentErrorDiagnostics): ThreadItemErrorCode | undefined {
  const text = `${diagnostics.errorCode ?? ""} ${message}`;
  const legacyStatus = message.match(/^(?:([45]\d\d)(?::|\s)|[^()\n]*\(([45]\d\d)\)\s*:)/);
  const status = diagnostics.statusCode ?? Number(legacyStatus?.[1] ?? legacyStatus?.[2]);
  const causes = diagnostics.causes ?? [];
  const transportText = [message, ...causes.flatMap((cause) => [cause.name, cause.message])].filter(Boolean).join(" ");
  const codes = [diagnostics.errorCode, ...causes.map((cause) => cause.code)].filter(Boolean).join(" ").toUpperCase();
  if (/^No API key\b/i.test(message) || /select an available model|selected model .* is not available|provider .* is disabled/i.test(message)) return "model_not_configured";
  const quota = /insufficient[_ ](?:quota|balance)|quota[_ ]exceeded|out of budget|billing[_ ](?:hard[_ ]|soft[_ ])?limit|usage limit|subscription_sharing_usage_limit_exceeded|GoUsageLimitError|FreeUsageLimitError/i;
  if (status === 402 || quota.test(diagnostics.errorCode ?? "") || ((!Number.isFinite(status) || status < 400 || status === 429) && quota.test(message))) return "quota_exceeded";
  if (status === 401) return "authentication_failed";
  if (status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_unavailable";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500 && status <= 599) return "provider_unavailable";
  if (/invalid[_ ]api[_ ]key|authentication[_ ]error|credentials.*expired/i.test(text)) return "authentication_failed";
  if (/rate.?limit|too many requests/i.test(text)) return "rate_limited";
  if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS/.test(codes) || /certificate|TLS handshake/i.test(transportText)) return "tls_error";
  if (/ENOTFOUND|EAI_AGAIN/.test(codes) || /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(transportText)) return "dns_error";
  if (/ECONNREFUSED/.test(codes) || /connection refused/i.test(transportText)) return "connection_refused";
  if (/TIMEOUT|ETIMEDOUT/.test(codes) || /timed? out|timeout/i.test(transportText)) return "timeout";
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(codes) || /socket hang up|other side closed/i.test(transportText)) return "connection_reset";
  if (/stream ended|ended without finish_reason|finish_reason: network_error/i.test(message)) return "stream_error";
  if (/connection.?error|network.?error|fetch failed/i.test(message)) return "network_error";
  return undefined;
}
