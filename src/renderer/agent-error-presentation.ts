import type { ThreadItemError, ThreadItemErrorCode } from "../shared/contracts.js";
import { t } from "./i18n.js";

const KNOWN_CODES = new Set<ThreadItemErrorCode>(["model_not_configured", "authentication_failed", "access_denied", "quota_exceeded", "rate_limited", "invalid_request", "model_unavailable", "provider_unavailable", "dns_error", "connection_refused", "connection_reset", "timeout", "tls_error", "stream_error", "network_error"]);

export function agentErrorPresentation(error: ThreadItemError): { title: string; message: string } {
  const code = error.code && KNOWN_CODES.has(error.code) ? error.code : "unknown";
  return { title: t(`agentError.${code}.title`), message: t(`agentError.${code}.message`) };
}

/** The same public fields are displayed and copied, with no request payload. */
export function agentErrorDiagnosticRows(error: ThreadItemError): Array<[string, string]> {
  const details = error.diagnostics;
  const rows: Array<[string, string]> = error.code === "model_not_configured"
    ? [[t("agentError.row.error"), t("agentError.row.notConfigured")]]
    : [[t("agentError.row.providerResponse"), error.message]];
  if (!details) return rows;
  if (details.provider) rows.push([t("agentError.row.provider"), details.provider]);
  if (details.model) rows.push([t("agentError.row.model"), details.model]);
  if (details.endpoint) rows.push([t("agentError.row.endpoint"), details.endpoint]);
  if (details.transport) rows.push([t("agentError.row.transport"), details.transport === "websocket" ? "WebSocket" : "HTTP / SSE"]);
  if (details.statusCode !== undefined) rows.push([details.transport === "websocket" ? t("agentError.row.providerStatus") : t("agentError.row.httpStatus"), String(details.statusCode)]);
  if (details.errorCode) rows.push([t("agentError.row.errorCode"), details.errorCode]);
  if (details.requestId) rows.push([t("agentError.row.requestId"), details.requestId]);
  if (details.retryAttempts !== undefined) rows.push([t("agentError.row.retryAttempts"), String(details.retryAttempts)]);
  if (details.network) {
    const source = { direct: t("agentError.network.direct"), manual: t("agentError.network.manual"), system: t("agentError.network.system"), environment: t("agentError.network.environment") }[details.network.source];
    rows.push([t("agentError.row.network"), `${source}${details.network.proxyUrl ? ` (${details.network.proxyUrl})` : ""}`]);
  }
  for (const cause of error.code === "model_not_configured" ? [] : details.causes ?? []) {
    const text = [cause.code, cause.name, cause.message].filter(Boolean).join(" · ");
    if (text) rows.push([t("agentError.row.cause"), text]);
  }
  return rows;
}

export function agentErrorDiagnosticText(error: ThreadItemError): string {
  const presentation = agentErrorPresentation(error);
  return [presentation.title, presentation.message, ...agentErrorDiagnosticRows(error).map(([label, value]) => `${label}: ${value}`)].join("\n");
}
