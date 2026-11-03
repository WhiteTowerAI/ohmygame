/**
 * Stable reasons a game can branch on. Messages are for people and may change;
 * codes only gain new members.
 */
export type OhMyGameErrorCode =
  /** The game has no deployment for this feature, or its manifest is invalid. */
  | "not_configured"
  /** An option passed to the SDK is outside its allowed range. */
  | "invalid_option"
  /** The deployment requires an OhMyGame account and no player is signed in. */
  | "sign_in_required"
  /** The call needs a connected room. */
  | "not_connected"
  /** A connection is already opening or open on this client. */
  | "busy"
  /** The call does not apply to this deployment's room policy. */
  | "unsupported"
  /** The service did not answer in time. */
  | "timeout"
  /** The service has reached its room limit; retry later. */
  | "room_limit"
  /** The service rejected a request, such as an expired invitation. */
  | "request_failed"
  /** The service answered with something the SDK does not understand. */
  | "invalid_response"
  /** The room closed or the service ended the connection. */
  | "connection_closed"
  /** A newer call replaced this one, or the client was disposed. */
  | "cancelled";

export class OhMyGameError extends Error {
  override readonly name = "OhMyGameError";
  constructor(
    readonly code: OhMyGameErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function isOhMyGameError(value: unknown, code?: OhMyGameErrorCode): value is OhMyGameError {
  return value instanceof OhMyGameError && (code === undefined || value.code === code);
}
