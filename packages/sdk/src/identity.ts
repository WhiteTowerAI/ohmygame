import { OhMyGameError } from "./errors.js";
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
    const response = await serviceRequest(this.options.endpoint ?? this.options.serverUrl, "/v1/guests", { method: "POST" });
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
}

/** @internal A request to the game service with its error body turned into an OhMyGameError. */
export async function serviceRequest(serverUrl: string, path: string, options?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(new URL(path, serverUrl), { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (cause) {
    const timedOut = isRecord(cause) && cause.name === "TimeoutError";
    throw new OhMyGameError(
      timedOut ? "timeout" : "request_failed",
      timedOut ? "The multiplayer service did not answer in time." : "The multiplayer service could not be reached.",
      { cause },
    );
  }
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => undefined);
    throw new OhMyGameError(
      "request_failed",
      isRecord(value) && typeof value.error === "string"
        ? value.error.slice(0, 300)
        : `The multiplayer request failed (${response.status}).`,
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
