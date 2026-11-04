import {
  CLOUD_NAME_PATTERN,
  LEADERBOARD_PAGE_MAX,
  SAVE_MAX_BYTES,
  type CloudConfig,
  type LeaderboardEntry,
  type LeaderboardOrder,
  type PlayerScore,
  type SaveRecord,
  type SaveSummary,
  type ScoreResult,
} from "./cloud-protocol.js";
import { isOhMyGameError, OhMyGameError } from "./errors.js";
import { GuestIdentity, serviceRequest, type IdentityProvider } from "./identity.js";
import { isRecord } from "./multiplayer-protocol.js";

/**
 * Saves that follow the player. Every write lands in the browser first and then on the
 * game service when the game has one ("cloud" in manifest.json): a save made offline is
 * sent when the service can be reached again. Without a service, or in a local build,
 * saves stay in this browser.
 */
export interface GameStorage {
  /** Whether saves reach the game service; false when they stay in this browser. */
  readonly cloud: boolean;
  /**
   * The save under key, or undefined. Reads the service's copy when it can be reached,
   * else this browser's. A save this browser has not sent yet wins over the service's.
   */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /**
   * Keeps value, plain JSON of at most SAVE_MAX_BYTES, under key. Resolves once it is
   * kept in this browser and, when it can be reached, on the service; offline it is sent
   * later. Rejects with quota_exceeded when the player keeps too many saves or it is too large.
   */
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** The keys the player keeps. */
  keys(): Promise<string[]>;
  /** Sends saves made while the service could not be reached. The SDK also does this when the browser comes back online. */
  sync(): Promise<void>;
}

/**
 * Leaderboards on the game service. Only signed-in players appear publicly; a guest's
 * score is kept for them, and me() tells them where it would place.
 */
export interface GameLeaderboard {
  /** Whether the game has a game service; without one every call rejects with not_configured. */
  readonly available: boolean;
  /**
   * Submits a score and resolves with the player's best on the board. The board keeps
   * the order of its first score: "desc" (the default) ranks higher scores first, "asc"
   * lower ones, as for a time. Rejects with rate_limited after 10 scores in a minute.
   */
  submit(board: string, score: number, options?: { order?: LeaderboardOrder }): Promise<ScoreResult>;
  /** Public entries, best first: 10 by default, at most LEADERBOARD_PAGE_MAX. */
  top(board: string, options?: { limit?: number; offset?: number }): Promise<LeaderboardEntry[]>;
  /** The player's best and rank, or undefined before their first score. */
  me(board: string): Promise<PlayerScore | undefined>;
}

/** One save as this browser keeps it. dirty: not yet on the service. A removed save is kept as deleted until the service hears. */
interface LocalSave {
  value?: unknown;
  deleted?: true;
  dirty?: true;
}

/** @internal How the cloud modules learn who the player is. */
export interface CloudPlayer {
  /** Whose saves this browser keeps for the current player; known without the network. */
  owner(): string;
  /** A token for the service. */
  token(): Promise<string>;
  /** The owner of saves made as a guest in this browser. */
  readonly guestOwner: string;
}

/** @internal The player for cloud requests: the signed-in account, or else a guest of the service. */
export function cloudPlayer(
  config: CloudConfig,
  identity: IdentityProvider | undefined,
  account: { readonly player?: { id: string } },
  storage: Storage | undefined,
): CloudPlayer {
  const guest = new GuestIdentity({ serverUrl: config.serverUrl, storage });
  const custom = identity !== undefined && identity !== account;
  return {
    guestOwner: "guest",
    owner: () => (account.player ? `account:${account.player.id}` : custom ? "player" : "guest"),
    async token() {
      return (await identity?.getToken()) ?? guest.getToken();
    },
  };
}

function checkName(value: string, what: string): string {
  if (typeof value !== "string" || !CLOUD_NAME_PATTERN.test(value))
    throw new OhMyGameError("invalid_option", `A ${what} is 1 to 64 letters, digits, dots, dashes or underscores.`);
  return value;
}
/** The service is out of reach: keep working from this browser. */
function unreachable(cause: unknown): boolean {
  return isOhMyGameError(cause, "offline") || isOhMyGameError(cause, "timeout");
}

/** @internal */
export class CloudStorage implements GameStorage {
  readonly cloud: boolean;
  private syncing?: Promise<void>;

  constructor(
    private readonly config: CloudConfig | undefined,
    private readonly player: CloudPlayer | undefined,
    private readonly storage: Storage | undefined,
    private readonly gameKey: string,
  ) {
    this.cloud = !!config && !!player;
    if (this.cloud && typeof window !== "undefined") window.addEventListener("online", () => void this.sync().catch(() => {}));
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    checkName(key, "save key");
    if (!this.cloud) return this.local("local", key)?.value as T | undefined;
    const owner = this.player!.owner();
    const mine = this.local(owner, key);
    if (mine?.dirty) {
      await this.send(owner, key, mine).catch((cause: unknown) => {
        if (!unreachable(cause)) throw cause;
      });
      return mine.value as T | undefined;
    }
    let remote: SaveRecord | undefined;
    try {
      const response = await this.request(`/saves/${key}`, {}, [404]);
      remote = response.status === 404 ? undefined : ((await response.json()) as SaveRecord);
    } catch (cause) {
      if (unreachable(cause)) return mine?.value as T | undefined;
      throw cause;
    }
    if (remote) {
      this.keep(owner, key, { value: remote.value });
      return remote.value as T;
    }
    // A player who signs in brings what they saved as a guest, when the account has none.
    if (owner !== this.player!.guestOwner) {
      const guest = this.local(this.player!.guestOwner, key);
      if (guest && !guest.deleted) {
        await this.set(key, guest.value);
        this.forget(this.player!.guestOwner, key);
        return guest.value as T;
      }
    }
    this.forget(owner, key);
    return undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    checkName(key, "save key");
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    if (json === undefined) throw new OhMyGameError("invalid_option", "A save must be JSON data.");
    if (new TextEncoder().encode(json).length > SAVE_MAX_BYTES)
      throw new OhMyGameError("quota_exceeded", `A save holds at most ${SAVE_MAX_BYTES / 1024} KB of JSON.`);
    const copy = JSON.parse(json) as unknown;
    if (!this.cloud) return this.keep("local", key, { value: copy });
    await this.write(key, { value: copy, dirty: true });
  }

  async remove(key: string): Promise<void> {
    checkName(key, "save key");
    if (!this.cloud) return this.forget("local", key);
    await this.write(key, { deleted: true, dirty: true });
  }

  async keys(): Promise<string[]> {
    if (!this.cloud) return this.localKeys("local");
    const owner = this.player!.owner();
    try {
      await this.sync();
      const response = await this.request("/saves");
      const remote = ((await response.json()) as SaveSummary[]).map((save) => save.key);
      return [...new Set([...remote, ...this.localKeys(owner)])].sort();
    } catch (cause) {
      if (!unreachable(cause)) throw cause;
      return this.localKeys(owner);
    }
  }

  sync(): Promise<void> {
    if (!this.cloud) return Promise.resolve();
    this.syncing ??= (async () => {
      try {
        const owner = this.player!.owner();
        for (const key of this.dirtyKeys(owner)) await this.send(owner, key, this.local(owner, key)!);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  /** Keeps the change here first, then tells the service; out of reach, it waits for sync. */
  private async write(key: string, save: LocalSave): Promise<void> {
    const owner = this.player!.owner();
    this.keep(owner, key, save);
    try {
      await this.send(owner, key, save);
    } catch (cause) {
      if (!unreachable(cause)) {
        // The service refused it and keeps its own copy, which the next read brings back; the game hears why.
        this.forget(owner, key);
        throw cause;
      }
    }
  }
  private async send(owner: string, key: string, save: LocalSave): Promise<void> {
    if (save.deleted) {
      await this.request(`/saves/${key}`, { method: "DELETE" });
      this.forget(owner, key);
    } else {
      await this.request(`/saves/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: save.value }),
      });
      // A newer write that arrived meanwhile stays dirty.
      if (JSON.stringify(this.local(owner, key)) === JSON.stringify(save)) this.keep(owner, key, { value: save.value });
    }
  }
  private async request(path: string, init: RequestInit = {}, accept: number[] = []): Promise<Response> {
    const token = await this.player!.token();
    return serviceRequest(
      this.config!.serverUrl,
      `/v1/games/${encodeURIComponent(this.config!.gameId)}${path}`,
      { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } },
      accept,
    );
  }

  private prefix(owner: string): string {
    return `ohmygame:save:${this.gameKey}:${owner}:`;
  }
  private local(owner: string, key: string): LocalSave | undefined {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.prefix(owner) + key) ?? "null");
      return isRecord(value) ? (value as LocalSave) : undefined;
    } catch {
      return undefined;
    }
  }
  private keep(owner: string, key: string, save: LocalSave): void {
    try {
      this.storage?.setItem(this.prefix(owner) + key, JSON.stringify(save));
    } catch {
      /* A full or disabled storage leaves only the service's copy. */
    }
  }
  private forget(owner: string, key: string): void {
    try {
      this.storage?.removeItem(this.prefix(owner) + key);
    } catch {
      /* Nothing to remove. */
    }
  }
  private entries(owner: string): [string, LocalSave][] {
    const prefix = this.prefix(owner);
    const found: [string, LocalSave][] = [];
    for (let index = 0; index < (this.storage?.length ?? 0); index++) {
      const name = this.storage!.key(index);
      if (!name?.startsWith(prefix)) continue;
      const save = this.local(owner, name.slice(prefix.length));
      if (save) found.push([name.slice(prefix.length), save]);
    }
    return found;
  }
  private localKeys(owner: string): string[] {
    return this.entries(owner).filter(([, save]) => !save.deleted).map(([key]) => key).sort();
  }
  private dirtyKeys(owner: string): string[] {
    return this.entries(owner).filter(([, save]) => save.dirty).map(([key]) => key);
  }
}

/** @internal */
export class CloudLeaderboard implements GameLeaderboard {
  readonly available: boolean;

  constructor(
    private readonly config: CloudConfig | undefined,
    private readonly player: CloudPlayer | undefined,
  ) {
    this.available = !!config && !!player;
  }

  async submit(board: string, score: number, options: { order?: LeaderboardOrder } = {}): Promise<ScoreResult> {
    checkName(board, "leaderboard name");
    if (typeof score !== "number" || !Number.isFinite(score)) throw new OhMyGameError("invalid_option", "A score is a finite number.");
    if (options.order !== undefined && options.order !== "desc" && options.order !== "asc")
      throw new OhMyGameError("invalid_option", 'order is "desc" or "asc".');
    const response = await this.request(`/leaderboards/${board}/scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score, ...(options.order ? { order: options.order } : {}) }),
    });
    return (await response.json()) as ScoreResult;
  }

  async top(board: string, options: { limit?: number; offset?: number } = {}): Promise<LeaderboardEntry[]> {
    checkName(board, "leaderboard name");
    const limit = options.limit ?? 10;
    const offset = options.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEADERBOARD_PAGE_MAX || !Number.isInteger(offset) || offset < 0)
      throw new OhMyGameError("invalid_option", `limit is 1 to ${LEADERBOARD_PAGE_MAX}, and offset a whole number.`);
    const response = await this.request(`/leaderboards/${board}?limit=${limit}&offset=${offset}`);
    return (await response.json()) as LeaderboardEntry[];
  }

  async me(board: string): Promise<PlayerScore | undefined> {
    checkName(board, "leaderboard name");
    const response = await this.request(`/leaderboards/${board}/me`, {}, [404]);
    return response.status === 404 ? undefined : ((await response.json()) as PlayerScore);
  }

  private async request(path: string, init: RequestInit = {}, accept: number[] = []): Promise<Response> {
    if (!this.available)
      throw new OhMyGameError("not_configured", "This game has no game service for leaderboards. Publish it to OhMyGame, or add \"cloud\" to manifest.json.");
    const token = await this.player!.token();
    return serviceRequest(
      this.config!.serverUrl,
      `/v1/games/${encodeURIComponent(this.config!.gameId)}${path}`,
      { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } },
      accept,
    );
  }
}
