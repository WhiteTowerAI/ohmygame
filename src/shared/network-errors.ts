/**
 * Why a request failed. `fetch` only says "fetch failed"; the useful part,
 * such as ECONNRESET or a connect timeout, sits on its cause.
 */
export function networkErrorDetail(cause: unknown): string {
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  if (!(inner instanceof Error)) return String(inner);
  const code = (inner as { code?: unknown }).code;
  return typeof code === "string" && !inner.message.includes(code) ? `${code}: ${inner.message}` : inner.message;
}

/** An error's message, with the reason a failed `fetch` leaves on its cause. */
export function errorMessageWithCause(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message === "fetch failed" && error.cause instanceof Error ? `fetch failed (${networkErrorDetail(error)})` : error.message;
}
