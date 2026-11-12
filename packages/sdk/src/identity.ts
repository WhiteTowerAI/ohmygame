import { OhMyGameError, type OhMyGameErrorCode } from "./errors.js";
import { isRecord } from "./multiplayer-protocol.js";

/**
 * Who the player is, as a bearer token for the game service. A provider returns
 * undefined when it has no player, for example before sign-in.
 */
export interface IdentityProvider {
  getToken(): Promise<string | undefined>;
}

export interface GuestIdentityOptions {
  serverUrl: string;
  /** Defaults to localStorage, so one browser stays one guest across tabs and visits. */
  storage?: Storage;
  /** @internal Where requests go when a test transport stands in for serverUrl. */
  endpoint?: string;
}

/**
 * A guest issued by the game service: no account, kept in browser storage until it
 * expires. The SDK falls back to it when the deployment allows guests.
 */
export class GuestIdentity implements IdentityProvider {
  private readonly storage?: Storage;
  private readonly key: string;
  private issuing?: Promise<string>;

  constructor(private readonly options: GuestIdentityOptions) {
    this.storage = options.storage ?? browserStorage();
    this.key = `ohmygame:multiplayer:guest:${options.serverUrl}`;
  }

  async getToken(): Promise<string> {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key) ?? "null");
      if (
        isRecord(value) &&
        typeof value.token === "string" &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > Date.now() + 60_000
      )
        return value.token;
    } catch {
      /* Request a fresh guest identity. */
    }
    // A join started while the client's early request is on its way waits for that one.
    this.issuing ??= this.issue().finally(() => {
      this.issuing = undefined;
    });
    return this.issuing;
  }

  private async issue(): Promise<string> {
    // Sending the old token, even an expired one, keeps the same guest and their saves.
    const previous = this.saved();
    const response = await serviceRequest(this.options.endpoint ?? this.options.serverUrl, "/v1/guests", {
      method: "POST",
      ...(previous ? { headers: { Authorization: `Bearer ${previous}` } } : {}),
    });
    const value: unknown = await response.json();
    if (!isRecord(value) || typeof value.token !== "string" || typeof value.expiresAt !== "number")
      throw new OhMyGameError("invalid_response", "Invalid guest session.");
    try {
      this.storage?.setItem(this.key, JSON.stringify(value));
    } catch {
      /* Guests can play without storage. */
    }
    return value.token;
  }

  private saved(): string | undefined {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key) ?? "null");
      return isRecord(value) && typeof value.token === "string" ? value.token : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Codes the service may send with an error; others become request_failed. */
const SERVICE_CODES = new Set<OhMyGameErrorCode>(["quota_exceeded", "rate_limited", "conflict"]);

/**
 * @internal A request to the game service with its error body turned into an OhMyGameError.
 * Statuses in accept come back as responses, such as 404 for a save that does not exist.
 */
export async function serviceRequest(serverUrl: string, path: string, options?: RequestInit, accept: readonly number[] = []): Promise<Response> {
  let response: Response;
  try {
    // The service knows players by bearer token, never by cookie. Requests without
    // credentials share one connection with the room client's matchmaking.
    response = await fetch(new URL(path, serverUrl), { credentials: "omit", ...options, signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    const timedOut = isRecord(cause) && cause.name === "TimeoutError";
    throw new OhMyGameError(
      timedOut ? "timeout" : "offline",
      timedOut ? "The game service did not answer in time." : "The game service could not be reached.",
      { cause },
    );
  }
  if (!response.ok && !accept.includes(response.status)) {
    const value: unknown = await response.json().catch(() => undefined);
    const code = isRecord(value) && SERVICE_CODES.has(value.code as OhMyGameErrorCode) ? (value.code as OhMyGameErrorCode) : "request_failed";
    throw new OhMyGameError(
      code,
      isRecord(value) && typeof value.error === "string"
        ? value.error.slice(0, 300)
        : `The game service request failed (${response.status}).`,
    );
  }
  return response;
}

/** @internal */
export function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
