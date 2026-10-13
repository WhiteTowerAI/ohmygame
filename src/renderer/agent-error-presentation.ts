import type { ThreadItemError } from "../shared/contracts.js";

export function agentErrorPresentation(error: ThreadItemError): { title: string; message: string } {
  switch (error.code) {
    case "model_not_configured": return { title: "Model setup required", message: "The selected model isn't configured. Choose an available model or connect its provider in Settings, then try again." };
    case "authentication_failed": return { title: "Authentication failed", message: "The provider rejected your credentials. Check its API key or sign in again in Settings." };
    case "access_denied": return { title: "Access denied", message: "The provider denied this request. Check your account's access to this model and the provider's response below." };
    case "quota_exceeded": return { title: "Provider quota exhausted", message: "Check your balance or usage limits with the provider, or choose another model." };
    case "rate_limited": return { title: "Provider rate limit reached", message: "The provider is receiving too many requests. Wait briefly, then try again." };
    case "invalid_request": return { title: "Model request rejected", message: "The provider rejected the request or its parameters. Check the model configuration and the provider's response below." };
    case "model_unavailable": return { title: "Model endpoint unavailable", message: "The provider couldn't find the requested endpoint or model. Check the Base URL and model ID in Settings." };
    case "provider_unavailable": return { title: "Provider service unavailable", message: "The provider or gateway returned a server error. Try again later or choose another provider." };
    case "dns_error": return { title: "DNS lookup failed", message: "A hostname could not be resolved. Check DNS, your network connection and the proxy address in Settings." };
    case "connection_refused": return { title: "Connection refused", message: "The target refused the connection. Check the endpoint and, if a proxy is in use, that it is running on the configured port." };
    case "connection_reset": return { title: "Connection interrupted", message: "The connection closed unexpectedly. Check your network or proxy, then try again." };
    case "timeout": return { title: "Model request timed out", message: "The request exceeded its timeout. Check your network and proxy, or try again when the provider is available." };
    case "tls_error": return { title: "Secure connection failed", message: "Certificate verification or the TLS connection failed. Check certificates and proxy settings." };
    case "stream_error": return { title: "Response interrupted", message: "The provider's response ended unexpectedly. The content already received is shown above; try again to continue." };
    case "network_error": return { title: "Connection error", message: "The model connection failed without a specific cause. Check your network or proxy settings, then try again." };
    default: return { title: "Model request failed", message: "The model request failed and its cause could not be determined. Review the provider's response below." };
  }
}

/** The same public fields are displayed and copied, with no request payload. */
export function agentErrorDiagnosticRows(error: ThreadItemError): Array<[string, string]> {
  const details = error.diagnostics;
  const rows: Array<[string, string]> = error.code === "model_not_configured"
    ? [["Error", "The selected model isn't configured."]]
    : [["Provider response", error.message]];
  if (!details) return rows;
  if (details.provider) rows.push(["Provider", details.provider]);
  if (details.model) rows.push(["Model", details.model]);
  if (details.endpoint) rows.push(["Endpoint", details.endpoint]);
  if (details.statusCode !== undefined) rows.push(["HTTP status", String(details.statusCode)]);
  if (details.errorCode) rows.push(["Error code", details.errorCode]);
  if (details.requestId) rows.push(["Request ID", details.requestId]);
  if (details.retryAttempts !== undefined) rows.push(["Retry attempts", String(details.retryAttempts)]);
  if (details.network) {
    const source = { direct: "Direct connection", manual: "Manual proxy", system: "System proxy", environment: "Environment proxy" }[details.network.source];
    rows.push(["Network configuration", `${source}${details.network.proxyUrl ? ` (${details.network.proxyUrl})` : ""}`]);
  }
  for (const cause of error.code === "model_not_configured" ? [] : details.causes ?? []) {
    const text = [cause.code, cause.name, cause.message].filter(Boolean).join(" · ");
    if (text) rows.push(["Cause", text]);
  }
  return rows;
}

export function agentErrorDiagnosticText(error: ThreadItemError): string {
  const presentation = agentErrorPresentation(error);
  return [presentation.title, presentation.message, ...agentErrorDiagnosticRows(error).map(([label, value]) => `${label}: ${value}`)].join("\n");
}
