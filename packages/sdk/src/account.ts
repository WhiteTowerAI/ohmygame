// Signing players in with their OhMyGame account. The account service issues a short-lived
// token for this game only, through OAuth's authorization code flow with PKCE; the game never
// sees the player's OhMyGame session. docs/game-sign-in.md describes the service's side.
import {
  isOhMyGamePlayer,
  type GameAccountConfig,
  type OhMyGamePlayer,
} from "./account-protocol.js";
import { OhMyGameError } from "./errors.js";
import type { IdentityProvider } from "./identity.js";
import { isRecord } from "./multiplayer-protocol.js";

/** The player's OhMyGame account in this game: game.auth from init. */
export interface GameAuth extends IdentityProvider {
  /** Whether players can sign in: true in games published to OhMyGame, false in local builds. */
  readonly available: boolean;
  /** The signed-in player, or undefined while they play as a guest. */
  readonly player: OhMyGamePlayer | undefined;
  /**
   * Signs the player in and resolves with them. Inside an OhMyGame page that already has the
   * player, this needs no window. Otherwise it opens OhMyGame sign-in in a popup; where the
   * popup is blocked, as on many phones, the page goes to sign-in and comes back, and init()
   * finishes signing in. Throws unsupported in a local build and cancelled when the player
   * closes the window.
   */
  signIn(): Promise<OhMyGamePlayer>;
  /** A current game token for game services, renewed when it is about to expire; undefined for a guest. */
  getToken(): Promise<string | undefined>;
}

interface MessageTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}
interface Popup extends MessageTarget {
  readonly closed: boolean;
}
interface SignInMessage {
  data: unknown;
  origin: string;
  source: unknown;
}

/** @internal The browser features sign-in uses; tests pass stand-ins. */
export interface AccountEnvironment {
  fetch: typeof fetch;
  storage?: Storage;
  location: { href: string; origin: string; assign(url: string): void };
  /** Replaces the address without loading it, to remove the sign-in response. */
  replaceUrl(url: string): void;
  /** Opens sign-in in a popup; null when the browser blocks it. */
  openPopup(url: string): Popup | null;
  /** The page that opened this one, when this page is the sign-in popup. */
  opener: MessageTarget | null;
  /** The embedding page, when the game runs in a frame. */
  parent: MessageTarget | null;
  close(): void;
  listen(listener: (message: SignInMessage) => void): () => void;
  crypto: Crypto;
  now(): number;
  /**
   * Runs one task at a time across this browser's tabs, as navigator.locks does. Without
   * it a renewal runs in this tab alone.
   */
  exclusive?<T>(name: string, task: () => Promise<T>): Promise<T>;
}

/** @internal */
export function browserAccountEnvironment(): AccountEnvironment | undefined {
  if (typeof window === "undefined" || typeof window.crypto?.subtle === "undefined") return undefined;
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    fetch: (...args) => fetch(...args),
    storage,
    location: window.location,
    replaceUrl: (url) => window.history.replaceState(window.history.state, "", url),
    openPopup: (url) => window.open(url, "ohmygame-sign-in", "popup,width=480,height=680"),
    opener: window.opener as MessageTarget | null,
    parent: window.parent !== window ? window.parent : null,
    close: () => window.close(),
    listen(listener) {
      const receive = (event: MessageEvent) => listener(event);
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    },
    crypto: window.crypto,
    now: () => Date.now(),
    ...(typeof navigator !== "undefined" && navigator.locks
      ? { exclusive: <T>(name: string, task: () => Promise<T>) => navigator.locks.request(name, task) as Promise<T> }
      : {}),
  };
}

interface Session {
  accessToken: string;
  /** Absent for a session an OhMyGame page handed over; it is asked again when this one expires. */
  refreshToken?: string;
  expiresAt: number;
  player: OhMyGamePlayer;
}
interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  popup: boolean;
  createdAt: number;
}

const SIGN_IN_MESSAGE = "ohmygame:sign-in";
const HOST_REQUEST = "ohmygame:account-request";
const HOST_RESPONSE = "ohmygame:account";
/** A token this close to expiring is renewed before use. */
const RENEW_BEFORE_MS = 30_000;
/** How long a sign-in may take before its response is ignored. */
const PENDING_MS = 10 * 60_000;
/** How long the game waits for an embedding OhMyGame page to answer. */
const HOST_WAIT_MS = 1500;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The token endpoint's answer, or undefined when it is not one. */
function readSession(value: unknown, now: number): Session | undefined {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.expires_in !== "number" ||
    !(value.expires_in > 0) ||
    (value.refresh_token !== undefined && typeof value.refresh_token !== "string") ||
    !isOhMyGamePlayer(value.player)
  )
    return undefined;
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token as string | undefined,
    expiresAt: now + value.expires_in * 1000,
    player: { id: value.player.id, name: value.player.name },
  };
}

function isStoredSession(value: unknown): value is Session {
  return (
    isRecord(value) &&
    typeof value.accessToken === "string" &&
    (value.refreshToken === undefined || typeof value.refreshToken === "string") &&
    typeof value.expiresAt === "number" &&
    isOhMyGamePlayer(value.player)
  );
}

/** @internal game.auth: the account sign-in a published game offers its players. */
export class OhMyGameAccount implements GameAuth {
  private session?: Session;
  private renewing?: Promise<Session | undefined>;
  private signingIn?: Promise<OhMyGamePlayer>;
  private hostAnswer?: Promise<Session | undefined>;
  private readonly key: string;
  private readonly hostOrigins: string[];

  constructor(
    private readonly config: GameAccountConfig | undefined,
    private readonly env: AccountEnvironment | undefined,
  ) {
    const issuer = config?.issuer.replace(/\/+$/, "");
    this.key = `ohmygame:account:${issuer ?? ""}`;
    this.hostOrigins = config ? config.hostOrigins ?? [new URL(config.issuer).origin] : [];
    this.session = this.load();
  }

  get available(): boolean {
    return this.config !== undefined && this.env !== undefined;
  }
  get player(): OhMyGamePlayer | undefined {
    return this.session?.player;
  }

  /**
   * Finishes a sign-in that left this page, and asks an embedding OhMyGame page for its
   * player. Returns "popup" when this page is the sign-in popup handing its result back;
   * the popup then closes, and the game should not start in it.
   */
  async start(): Promise<"popup" | undefined> {
    if (!this.available) return undefined;
    const handed = await this.finishRedirect();
    if (handed) return handed;
    if (!this.session && this.env!.parent) this.hostAnswer = this.askHost();
    return undefined;
  }

  async getToken(): Promise<string | undefined> {
    if (!this.available) return undefined;
    if (!this.session && this.hostAnswer) await this.hostAnswer;
    const session = this.session;
    if (!session) return undefined;
    if (session.expiresAt - this.env!.now() > RENEW_BEFORE_MS) return session.accessToken;
    // Two tabs renewing with one refresh token would look like a stolen token and end the
    // sign-in, so tabs renew one at a time; the second then finds the first one's session.
    const renew = () => this.renew(session);
    this.renewing ??= (this.env!.exclusive ? this.env!.exclusive(`${this.key}:renew`, renew) : renew()).finally(() => {
      this.renewing = undefined;
    });
    return (await this.renewing)?.accessToken;
  }

  signIn(): Promise<OhMyGamePlayer> {
    if (!this.available)
      return Promise.reject(
        new OhMyGameError(
          "unsupported",
          "OhMyGame sign-in is available once the game is published to OhMyGame. Local builds play as guests.",
        ),
      );
    this.signingIn ??= this.interactiveSignIn().finally(() => {
      this.signingIn = undefined;
    });
    return this.signingIn;
  }

  private async interactiveSignIn(): Promise<OhMyGamePlayer> {
    const env = this.env!;
    if (env.parent) {
      const handed = await (this.hostAnswer ?? (this.hostAnswer = this.askHost()));
      if (handed) return handed.player;
    }
    const verifier = base64url(env.crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await env.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const current = new URL(env.location.href);
    const pending: Pending = {
      state: base64url(env.crypto.getRandomValues(new Uint8Array(16))),
      verifier,
      redirectUri: `${current.origin}${current.pathname}`,
      popup: true,
      createdAt: env.now(),
    };
    const authorize = new URL(`${this.issuer}/v1/game-auth/authorize`);
    for (const [name, value] of Object.entries({
      response_type: "code",
      redirect_uri: pending.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: pending.state,
    }))
      authorize.searchParams.set(name, value);
    this.savePending(pending);
    const popup = env.openPopup(authorize.href);
    if (!popup) {
      // A page in a frame can't sign in in place: the sign-in page refuses to be framed, and
      // the frame would be left on it. The player allows the popup and tries again.
      if (env.parent) {
        this.savePending(undefined);
        throw new OhMyGameError("cancelled", "The sign-in window was blocked. Allow pop-ups for this game and try again.");
      }
      // A blocked popup signs in on this page instead; init() completes it when the page returns.
      this.savePending({ ...pending, popup: false });
      env.location.assign(authorize.href);
      return new Promise<OhMyGamePlayer>(() => {});
    }
    const before = this.load()?.accessToken;
    const code = await new Promise<string | undefined>((resolve, reject) => {
      const timer = setInterval(() => {
        if (!popup.closed) return;
        finish();
        // A sign-in page that cut the popup off from this page finishes there and saves the player.
        const saved = this.load();
        if (saved && saved.accessToken !== before) resolve(undefined);
        else reject(new OhMyGameError("cancelled", "Sign-in was closed before it finished."));
      }, 500);
      const stop = env.listen(({ data, origin, source }) => {
        // Only this game's own page, opened by this call, can answer it.
        if (origin !== env.location.origin || source !== popup || !isRecord(data) || data.type !== SIGN_IN_MESSAGE || data.state !== pending.state)
          return;
        finish();
        if (typeof data.code === "string" && data.code) resolve(data.code);
        else reject(new OhMyGameError("cancelled", "Sign-in did not complete."));
      });
      const finish = () => {
        clearInterval(timer);
        stop();
      };
    }).finally(() => this.savePending(undefined));
    if (code === undefined) {
      this.session = this.load();
      return this.session!.player;
    }
    return (await this.exchange(code, pending)).player;
  }

  /** Handles the account service's return to this page, when this sign-in started here. */
  private async finishRedirect(): Promise<"popup" | undefined> {
    const env = this.env!;
    const url = new URL(env.location.href);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code") ?? undefined;
    const pending = this.loadPending();
    // A game in a frame, as on its website page, keeps its storage apart from this popup's,
    // so the popup finds no sign-in of its own, or an abandoned one. It hands the result to
    // the game that opened it, which checks the state and holds the verifier.
    if (state && pending?.state !== state && env.opener && (code || url.searchParams.has("error"))) {
      env.opener.postMessage({ type: SIGN_IN_MESSAGE, state, code }, env.location.origin);
      env.close();
      return "popup";
    }
    if (!state || !pending || pending.state !== state) return undefined;
    if (pending.popup) {
      if (env.opener) env.opener.postMessage({ type: SIGN_IN_MESSAGE, state, code }, env.location.origin);
      // Without the opener, the popup signs in itself; the game finds the player saved when it closes.
      else if (code) await this.exchange(code, pending).catch(() => undefined);
      env.close();
      return "popup";
    }
    for (const name of ["code", "state", "error", "error_description"]) url.searchParams.delete(name);
    env.replaceUrl(url.href);
    this.savePending(undefined);
    if (code) await this.exchange(code, pending).catch(() => undefined);
    return undefined;
  }

  private async exchange(code: string, pending: Pending): Promise<Session> {
    const session = await this.token({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
    });
    if (!session) throw new OhMyGameError("request_failed", "OhMyGame did not accept the sign-in. Try again.");
    this.save(session);
    return session;
  }

  private async renew(session: Session): Promise<Session | undefined> {
    // Another tab of this game may have renewed already; its rotated token replaces ours.
    const stored = this.load();
    if (stored && stored.expiresAt - this.env!.now() > RENEW_BEFORE_MS) {
      this.session = stored;
      return stored;
    }
    // A token another tab rotated in is the live one; ours was spent.
    const latest = stored ?? session;
    if (!latest.refreshToken) {
      this.save(undefined);
      return (this.hostAnswer = this.askHost());
    }
    const renewed = await this.token({ grant_type: "refresh_token", refresh_token: latest.refreshToken });
    this.save(renewed);
    return renewed;
  }

  /** The token endpoint's session; undefined when it refuses the grant, so the player is signed out. */
  private async token(body: Record<string, string>): Promise<Session | undefined> {
    let response: Response;
    try {
      response = await this.env!.fetch(`${this.issuer}/v1/game-auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new OhMyGameError("request_failed", "OhMyGame sign-in could not be reached.", { cause });
    }
    if (response.status === 400 || response.status === 401) return undefined;
    if (!response.ok) throw new OhMyGameError("request_failed", `OhMyGame sign-in failed (${response.status}).`);
    const session = readSession(await response.json().catch(() => undefined), this.env!.now());
    if (!session) throw new OhMyGameError("invalid_response", "OhMyGame sign-in answered with an invalid session.");
    return session;
  }

  /** Asks the embedding page for its signed-in player; only OhMyGame's own pages are believed. */
  private askHost(): Promise<Session | undefined> {
    const env = this.env!;
    const parent = env.parent;
    if (!parent) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(undefined), HOST_WAIT_MS);
      const stop = env.listen(({ data, origin, source }) => {
        if (source !== parent || !this.hostOrigins.includes(origin) || !isRecord(data) || data.type !== HOST_RESPONSE) return;
        const session = readSession(data.session, env.now());
        if (session) this.save(session);
        done(session);
      });
      const done = (session: Session | undefined) => {
        clearTimeout(timer);
        stop();
        resolve(session);
      };
      for (const origin of this.hostOrigins) parent.postMessage({ type: HOST_REQUEST }, origin);
    });
  }

  private get issuer(): string {
    return this.config!.issuer.replace(/\/+$/, "");
  }

  private load(): Session | undefined {
    try {
      const value: unknown = JSON.parse(this.env?.storage?.getItem(this.key) ?? "null");
      return isStoredSession(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  private save(session: Session | undefined): void {
    this.session = session;
    try {
      if (session) this.env?.storage?.setItem(this.key, JSON.stringify(session));
      else this.env?.storage?.removeItem(this.key);
    } catch {
      /* Without storage the player stays signed in until the page closes. */
    }
  }
  private loadPending(): Pending | undefined {
    try {
      const value: unknown = JSON.parse(this.env?.storage?.getItem(`${this.key}:pending`) ?? "null");
      if (
        isRecord(value) &&
        typeof value.state === "string" &&
        typeof value.verifier === "string" &&
        typeof value.redirectUri === "string" &&
        typeof value.popup === "boolean" &&
        typeof value.createdAt === "number" &&
        this.env!.now() - value.createdAt < PENDING_MS
      )
        return value as unknown as Pending;
    } catch {
      /* A broken record is no sign-in in progress. */
    }
    return undefined;
  }
  private savePending(pending: Pending | undefined): void {
    try {
      if (pending) this.env?.storage?.setItem(`${this.key}:pending`, JSON.stringify(pending));
      else this.env?.storage?.removeItem(`${this.key}:pending`);
    } catch {
      /* Sign-in in a popup still works; a page redirect cannot finish without storage. */
    }
  }
}
