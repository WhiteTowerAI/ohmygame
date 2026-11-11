import { MATCH_BOARD_PREFIX, type LeaderboardEntry, type LeaderboardOrder, type PlayerScore, type SaveRecord, type SaveSummary } from "@ohmygame/sdk/cloud-protocol";

/**
 * Where the game service keeps cloud saves and leaderboards. Player IDs are the service's
 * own, "account:<id>" or "guest:<id>". MemoryGameDataStore serves local development and
 * PostgresGameDataStore a hosted service; a self-hosted service may supply its own.
 */
export interface ServerStore {
  getSave(gameId: string, playerId: string, key: string): Promise<SaveRecord | undefined>;
  listSaves(gameId: string, playerId: string): Promise<SaveSummary[]>;
  /**
   * Writes a save. value is its JSON. Throws QuotaError when the player already keeps
   * maxKeys other keys, and ConflictError when ifVersion is not the current version.
   */
  putSave(
    gameId: string,
    playerId: string,
    key: string,
    value: string,
    options: { maxKeys: number; ifVersion?: number; now: number },
  ): Promise<SaveRecord>;
  deleteSave(gameId: string, playerId: string, key: string): Promise<boolean>;
  /**
   * Keeps the player's best score on a board. The board takes the order of its first
   * score, "desc" when it names none; a later score naming another order throws ConflictError.
   */
  submitScore(
    gameId: string,
    board: string,
    score: { playerId: string; name: string; value: number; public: boolean; order?: LeaderboardOrder; now: number },
  ): Promise<{ improved: boolean }>;
  /**
   * Adds delta to the player's score on a board that counts up, such as wins, which the
   * service keeps for rules it trusts. The board ranks higher scores first.
   */
  addScore(
    gameId: string,
    board: string,
    score: { playerId: string; name: string; delta: number; public: boolean; now: number },
  ): Promise<void>;
  /** Public entries from rank offset + 1, best first; ties go to the earlier score. */
  topScores(gameId: string, board: string, limit: number, offset: number): Promise<LeaderboardEntry[]>;
  /** The player's best, ranked among public entries. */
  playerScore(gameId: string, board: string, playerId: string): Promise<PlayerScore | undefined>;
  /** Records that the player used the game, for pruning. */
  touch(gameId: string, playerId: string, now: number): Promise<void>;
  /**
   * Gives a guest's saves and scores in one game to an account, when the guest signs in.
   * A save the account already has stays the account's, and saves past maxKeys stay
   * behind; on a board the account keeps the better score, or the sum on a board of match
   * results, now public under its name. Afterwards the guest keeps nothing in that game.
   */
  mergeGuest(
    gameId: string,
    guestId: string,
    account: { playerId: string; name: string },
    options: { maxKeys: number; now: number },
  ): Promise<GuestMerge>;
  /** Removes every save and score of the player, in every game. */
  deletePlayer(playerId: string): Promise<void>;
  /** Removes the data of guests and of accounts that have not used a game since these times. */
  prune(before: { guest: number; account: number }): Promise<void>;
  close(): Promise<void>;
}

/** What mergeGuest gave the account: saves it took over and boards it took a score from. */
export interface GuestMerge {
  saves: number;
  scores: number;
}

export class QuotaError extends Error {}
export class ConflictError extends Error {}

const ORDERS: Record<LeaderboardOrder, string> = { desc: "higher scores first", asc: "lower scores first" };
export function orderConflict(order: LeaderboardOrder): ConflictError {
  return new ConflictError(`This leaderboard ranks ${ORDERS[order]}.`);
}

interface MemoryScore {
  playerId: string;
  name: string;
  score: number;
  at: number;
  public: boolean;
}

/** Kept in the process: for local development and tests. */
export class MemoryGameDataStore implements ServerStore {
  private readonly saves = new Map<string, Map<string, SaveRecord & { bytes: number }>>();
  private readonly boards = new Map<string, { order: LeaderboardOrder; scores: Map<string, MemoryScore> }>();
  private readonly seen = new Map<string, number>();

  async getSave(gameId: string, playerId: string, key: string) {
    const record = this.saves.get(slot(gameId, playerId))?.get(key);
    if (!record) return undefined;
    const { bytes: _bytes, ...save } = record;
    return structuredClone(save);
  }
  async listSaves(gameId: string, playerId: string) {
    return [...(this.saves.get(slot(gameId, playerId))?.values() ?? [])]
      .map(({ key, version, updatedAt, bytes }) => ({ key, version, updatedAt, bytes }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
  async putSave(gameId: string, playerId: string, key: string, value: string, options: { maxKeys: number; ifVersion?: number; now: number }) {
    const saves = this.saves.get(slot(gameId, playerId)) ?? new Map<string, SaveRecord & { bytes: number }>();
    const current = saves.get(key);
    if (options.ifVersion !== undefined && options.ifVersion !== (current?.version ?? 0))
      throw new ConflictError("The save changed since it was read.");
    if (!current && saves.size >= options.maxKeys) throw new QuotaError(`A player keeps at most ${options.maxKeys} saves in a game.`);
    const record = { key, value: JSON.parse(value) as unknown, version: (current?.version ?? 0) + 1, updatedAt: options.now, bytes: Buffer.byteLength(value) };
    saves.set(key, record);
    this.saves.set(slot(gameId, playerId), saves);
    const { bytes: _bytes, ...save } = record;
    return structuredClone(save);
  }
  async deleteSave(gameId: string, playerId: string, key: string) {
    return this.saves.get(slot(gameId, playerId))?.delete(key) ?? false;
  }
  async submitScore(gameId: string, board: string, score: { playerId: string; name: string; value: number; public: boolean; order?: LeaderboardOrder; now: number }) {
    const entry = this.boards.get(slot(gameId, board)) ?? { order: score.order ?? "desc", scores: new Map<string, MemoryScore>() };
    if (score.order && entry.order !== score.order) throw orderConflict(entry.order);
    this.boards.set(slot(gameId, board), entry);
    const previous = entry.scores.get(score.playerId);
    const improved = !previous || better(entry.order, score.value, previous.score);
    entry.scores.set(score.playerId, {
      playerId: score.playerId,
      name: score.name,
      public: score.public,
      score: improved ? score.value : previous!.score,
      at: improved ? score.now : previous!.at,
    });
    return { improved };
  }
  async addScore(gameId: string, board: string, score: { playerId: string; name: string; delta: number; public: boolean; now: number }) {
    const entry = this.boards.get(slot(gameId, board)) ?? { order: "desc" as const, scores: new Map<string, MemoryScore>() };
    if (entry.order !== "desc") throw orderConflict(entry.order);
    this.boards.set(slot(gameId, board), entry);
    const previous = entry.scores.get(score.playerId);
    entry.scores.set(score.playerId, {
      playerId: score.playerId,
      name: score.name,
      public: score.public,
      score: (previous?.score ?? 0) + score.delta,
      at: score.now,
    });
  }
  async topScores(gameId: string, board: string, limit: number, offset: number) {
    const entry = this.boards.get(slot(gameId, board));
    if (!entry) return [];
    return [...entry.scores.values()]
      .filter((score) => score.public)
      .sort((left, right) => compare(entry.order, left, right))
      .slice(offset, offset + limit)
      .map((score, index) => ({ rank: offset + index + 1, playerId: publicPlayerId(score.playerId), name: score.name, score: score.score, at: score.at }));
  }
  async playerScore(gameId: string, board: string, playerId: string) {
    const entry = this.boards.get(slot(gameId, board));
    const own = entry?.scores.get(playerId);
    if (!entry || !own) return undefined;
    const ahead = [...entry.scores.values()].filter((score) => score.public && score.playerId !== playerId && compare(entry.order, score, own) < 0);
    return { score: own.score, at: own.at, rank: ahead.length + 1, public: own.public };
  }
  async touch(gameId: string, playerId: string, now: number) {
    this.seen.set(slot(gameId, playerId), now);
  }
  async mergeGuest(gameId: string, guestId: string, account: { playerId: string; name: string }, options: { maxKeys: number; now: number }) {
    const merged: GuestMerge = { saves: 0, scores: 0 };
    const from = this.saves.get(slot(gameId, guestId));
    if (from) {
      const to = this.saves.get(slot(gameId, account.playerId)) ?? new Map<string, SaveRecord & { bytes: number }>();
      for (const [key, save] of [...from].sort(([left], [right]) => left.localeCompare(right))) {
        if (to.has(key) || to.size >= options.maxKeys) continue;
        to.set(key, { ...save, version: 1 });
        merged.saves++;
      }
      this.saves.set(slot(gameId, account.playerId), to);
      this.saves.delete(slot(gameId, guestId));
    }
    for (const [boardKey, { order, scores }] of this.boards) {
      if (!boardKey.startsWith(`${gameId}\u0000`)) continue;
      const guest = scores.get(guestId);
      if (!guest) continue;
      const own = scores.get(account.playerId);
      const kept =
        !own ? guest
        : boardKey.slice(gameId.length + 1).startsWith(MATCH_BOARD_PREFIX) ? { score: own.score + guest.score, at: Math.max(own.at, guest.at) }
        : better(order, guest.score, own.score) ? guest
        : own;
      scores.set(account.playerId, { playerId: account.playerId, name: account.name, public: true, score: kept.score, at: kept.at });
      scores.delete(guestId);
      merged.scores++;
    }
    this.seen.delete(slot(gameId, guestId));
    return merged;
  }
  async deletePlayer(playerId: string) {
    for (const [key] of this.saves) if (key.endsWith(`\u0000${playerId}`)) this.saves.delete(key);
    for (const { scores } of this.boards.values()) scores.delete(playerId);
    for (const [key] of this.seen) if (key.endsWith(`\u0000${playerId}`)) this.seen.delete(key);
  }
  async prune(before: { guest: number; account: number }) {
    for (const [key, at] of this.seen) {
      const [gameId, playerId] = key.split("\u0000") as [string, string];
      if (at >= (playerId.startsWith("guest:") ? before.guest : before.account)) continue;
      this.seen.delete(key);
      this.saves.delete(key);
      for (const [boardKey, { scores }] of this.boards) if (boardKey.startsWith(`${gameId}\u0000`)) scores.delete(playerId);
    }
  }
  async close() {}

  /** Everything kept for a game, for the local viewer: boards best first, and who has saves. */
  describe(gameId: string): {
    boards: { board: string; order: LeaderboardOrder; entries: { playerId: string; name: string; score: number; public: boolean }[] }[];
    saves: { playerId: string; keys: string[] }[];
  } {
    const prefix = `${gameId}\u0000`;
    const boards = [...this.boards]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, { order, scores }]) => ({
        board: key.slice(prefix.length),
        order,
        entries: [...scores.values()]
          .sort((left, right) => compare(order, left, right))
          .map(({ playerId, name, score, public: shown }) => ({ playerId: publicPlayerId(playerId), name, score, public: shown })),
      }));
    const saves = [...this.saves]
      .filter(([key, kept]) => key.startsWith(prefix) && kept.size)
      .map(([key, kept]) => ({ playerId: publicPlayerId(key.slice(prefix.length)), keys: [...kept.keys()].sort() }));
    return { boards, saves };
  }
}

function slot(gameId: string, name: string): string {
  return `${gameId}\u0000${name}`;
}
export function better(order: LeaderboardOrder, score: number, than: number): boolean {
  return order === "desc" ? score > than : score < than;
}
function compare(order: LeaderboardOrder, left: { score: number; at: number }, right: { score: number; at: number }): number {
  if (left.score !== right.score) return better(order, left.score, right.score) ? -1 : 1;
  return left.at - right.at;
}
/** Games see a player by their OhMyGame account ID. */
export function publicPlayerId(playerId: string): string {
  return playerId.startsWith("account:") ? playerId.slice("account:".length) : playerId;
}
