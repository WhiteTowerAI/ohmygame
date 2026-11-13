import pg from "pg";
import { MATCH_BOARD_PREFIX, type LeaderboardOrder } from "@ohmygame/sdk/cloud-protocol";
import { better, ConflictError, orderConflict, publicPlayerId, QuotaError, type ServerStore } from "./game-data.js";

/**
 * Each migration runs once, in order, inside a transaction; ohmygame_schema records the
 * last one applied. Add new steps at the end and never change an applied one.
 */
const MIGRATIONS = [
  `CREATE TABLE ohmygame_saves (
     game_id text NOT NULL, player_id text NOT NULL, key text NOT NULL,
     value text NOT NULL, bytes integer NOT NULL, version integer NOT NULL, updated_at bigint NOT NULL,
     PRIMARY KEY (game_id, player_id, key));
   CREATE INDEX ohmygame_saves_player ON ohmygame_saves (player_id);
   CREATE TABLE ohmygame_boards (
     game_id text NOT NULL, board text NOT NULL, rank_order text NOT NULL CHECK (rank_order IN ('desc', 'asc')),
     PRIMARY KEY (game_id, board));
   CREATE TABLE ohmygame_scores (
     game_id text NOT NULL, board text NOT NULL, player_id text NOT NULL,
     name text NOT NULL, score double precision NOT NULL, at bigint NOT NULL, public boolean NOT NULL,
     PRIMARY KEY (game_id, board, player_id),
     FOREIGN KEY (game_id, board) REFERENCES ohmygame_boards ON DELETE CASCADE);
   CREATE INDEX ohmygame_scores_rank ON ohmygame_scores (game_id, board, public, score, at);
   CREATE INDEX ohmygame_scores_player ON ohmygame_scores (player_id);
   CREATE TABLE ohmygame_players (
     game_id text NOT NULL, player_id text NOT NULL, last_seen bigint NOT NULL,
     PRIMARY KEY (game_id, player_id));
   CREATE INDEX ohmygame_players_seen ON ohmygame_players (last_seen);`,
];

export interface PostgresGameDataStoreOptions {
  /** A postgres:// connection string, or an existing pool the store will not close. */
  connection: string | pg.Pool;
}

/** Cloud saves and leaderboards in Postgres, for a hosted game service. */
export class PostgresGameDataStore implements ServerStore {
  private readonly pool: pg.Pool;
  private readonly ownsPool: boolean;
  private ready?: Promise<void>;

  constructor(options: PostgresGameDataStoreOptions) {
    this.ownsPool = typeof options.connection === "string";
    this.pool = typeof options.connection === "string" ? new pg.Pool({ connectionString: options.connection, max: 10 }) : options.connection;
  }

  /** Creates or upgrades the tables. Every other call waits for it. */
  migrate(): Promise<void> {
    this.ready ??= this.transaction(async (client) => {
      // One service instance migrates at a time.
      await client.query("SELECT pg_advisory_xact_lock(4207311)");
      await client.query("CREATE TABLE IF NOT EXISTS ohmygame_schema (version integer NOT NULL)");
      const { rows } = await client.query<{ version: number }>("SELECT version FROM ohmygame_schema");
      let version = rows[0]?.version ?? 0;
      if (!rows.length) await client.query("INSERT INTO ohmygame_schema VALUES (0)");
      for (; version < MIGRATIONS.length; version++) {
        await client.query(MIGRATIONS[version]!);
        await client.query("UPDATE ohmygame_schema SET version = $1", [version + 1]);
      }
    }).catch((cause: unknown) => {
      this.ready = undefined;
      throw cause;
    });
    return this.ready;
  }

  async getSave(gameId: string, playerId: string, key: string) {
    const { rows } = await this.query<{ value: string; version: number; updated_at: string }>(
      "SELECT value, version, updated_at FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2 AND key = $3",
      [gameId, playerId, key],
    );
    const row = rows[0];
    return row ? { key, value: JSON.parse(row.value) as unknown, version: row.version, updatedAt: Number(row.updated_at) } : undefined;
  }
  async listSaves(gameId: string, playerId: string) {
    const { rows } = await this.query<{ key: string; version: number; updated_at: string; bytes: number }>(
      "SELECT key, version, updated_at, bytes FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2 ORDER BY key",
      [gameId, playerId],
    );
    return rows.map((row) => ({ key: row.key, version: row.version, updatedAt: Number(row.updated_at), bytes: row.bytes }));
  }
  async putSave(gameId: string, playerId: string, key: string, value: string, options: { maxKeys: number; ifVersion?: number; now: number }) {
    await this.migrate();
    return this.transaction(async (client) => {
      // Serializes writes by one player to one game, so the key count holds.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ' ' || $2))", [gameId, playerId]);
      const { rows } = await client.query<{ version: number }>(
        "SELECT version FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2 AND key = $3",
        [gameId, playerId, key],
      );
      const current = rows[0]?.version;
      if (options.ifVersion !== undefined && options.ifVersion !== (current ?? 0))
        throw new ConflictError("The save changed since it was read.");
      if (current === undefined) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*) FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2",
          [gameId, playerId],
        );
        if (Number(count.rows[0]!.count) >= options.maxKeys) throw new QuotaError(`A player keeps at most ${options.maxKeys} saves in a game.`);
      }
      const version = (current ?? 0) + 1;
      await client.query(
        `INSERT INTO ohmygame_saves VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (game_id, player_id, key) DO UPDATE SET value = $4, bytes = $5, version = $6, updated_at = $7`,
        [gameId, playerId, key, value, Buffer.byteLength(value), version, options.now],
      );
      return { key, value: JSON.parse(value) as unknown, version, updatedAt: options.now };
    });
  }
  async deleteSave(gameId: string, playerId: string, key: string) {
    const result = await this.query("DELETE FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2 AND key = $3", [gameId, playerId, key]);
    return (result.rowCount ?? 0) > 0;
  }
  async submitScore(gameId: string, board: string, score: { playerId: string; name: string; value: number; public: boolean; order?: LeaderboardOrder; now: number }) {
    await this.migrate();
    return this.transaction(async (client) => {
      await client.query("INSERT INTO ohmygame_boards VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [gameId, board, score.order ?? "desc"]);
      const { rows } = await client.query<{ rank_order: LeaderboardOrder }>(
        "SELECT rank_order FROM ohmygame_boards WHERE game_id = $1 AND board = $2",
        [gameId, board],
      );
      const order = rows[0]!.rank_order;
      if (score.order && order !== score.order) throw orderConflict(order);
      const better = order === "desc" ? "EXCLUDED.score > s.score" : "EXCLUDED.score < s.score";
      // The best score and its time stay unless this one beats it; the name and visibility follow the player.
      const result = await client.query<{ improved: boolean }>(
        `INSERT INTO ohmygame_scores AS s VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (game_id, board, player_id) DO UPDATE SET
           name = EXCLUDED.name, public = EXCLUDED.public,
           score = CASE WHEN ${better} THEN EXCLUDED.score ELSE s.score END,
           at = CASE WHEN ${better} THEN EXCLUDED.at ELSE s.at END
         RETURNING (xmax = 0 OR at = $6) AS improved`,
        [gameId, board, score.playerId, score.name, score.value, score.now, score.public],
      );
      return { improved: result.rows[0]!.improved };
    });
  }
  async addScore(gameId: string, board: string, score: { playerId: string; name: string; delta: number; public: boolean; now: number }) {
    await this.migrate();
    await this.transaction(async (client) => {
      await client.query("INSERT INTO ohmygame_boards VALUES ($1, $2, 'desc') ON CONFLICT DO NOTHING", [gameId, board]);
      const { rows } = await client.query<{ rank_order: LeaderboardOrder }>(
        "SELECT rank_order FROM ohmygame_boards WHERE game_id = $1 AND board = $2",
        [gameId, board],
      );
      if (rows[0]!.rank_order !== "desc") throw orderConflict(rows[0]!.rank_order);
      await client.query(
        `INSERT INTO ohmygame_scores AS s VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (game_id, board, player_id) DO UPDATE SET
           name = EXCLUDED.name, public = EXCLUDED.public, score = s.score + EXCLUDED.score, at = EXCLUDED.at`,
        [gameId, board, score.playerId, score.name, score.delta, score.now, score.public],
      );
    });
  }
  async topScores(gameId: string, board: string, limit: number, offset: number) {
    const order = await this.order(gameId, board);
    if (!order) return [];
    const { rows } = await this.query<{ player_id: string; name: string; score: number; at: string }>(
      `SELECT player_id, name, score, at FROM ohmygame_scores
       WHERE game_id = $1 AND board = $2 AND public
       ORDER BY score ${order === "desc" ? "DESC" : "ASC"}, at ASC LIMIT $3 OFFSET $4`,
      [gameId, board, limit, offset],
    );
    return rows.map((row, index) => ({ rank: offset + index + 1, playerId: publicPlayerId(row.player_id), name: row.name, score: row.score, at: Number(row.at) }));
  }
  async playerScore(gameId: string, board: string, playerId: string) {
    const order = await this.order(gameId, board);
    if (!order) return undefined;
    const ahead = order === "desc" ? "o.score > s.score" : "o.score < s.score";
    const { rows } = await this.query<{ score: number; at: string; public: boolean; ahead: string }>(
      `SELECT s.score, s.at, s.public,
         (SELECT count(*) FROM ohmygame_scores o
          WHERE o.game_id = s.game_id AND o.board = s.board AND o.public AND o.player_id <> s.player_id
            AND (${ahead} OR (o.score = s.score AND o.at < s.at))) AS ahead
       FROM ohmygame_scores s WHERE s.game_id = $1 AND s.board = $2 AND s.player_id = $3`,
      [gameId, board, playerId],
    );
    const row = rows[0];
    return row ? { score: row.score, at: Number(row.at), rank: Number(row.ahead) + 1, public: row.public } : undefined;
  }
  async touch(gameId: string, playerId: string, now: number) {
    await this.query(
      `INSERT INTO ohmygame_players VALUES ($1, $2, $3)
       ON CONFLICT (game_id, player_id) DO UPDATE SET last_seen = GREATEST(ohmygame_players.last_seen, $3)`,
      [gameId, playerId, now],
    );
  }
  async mergeGuest(gameId: string, guestId: string, account: { playerId: string; name: string }, options: { maxKeys: number; now: number }) {
    await this.migrate();
    return this.transaction(async (client) => {
      // The same lock as the account's own writes, so its key count holds.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ' ' || $2))", [gameId, account.playerId]);
      const count = await client.query<{ count: string }>(
        "SELECT count(*) FROM ohmygame_saves WHERE game_id = $1 AND player_id = $2",
        [gameId, account.playerId],
      );
      const room = Math.max(0, options.maxKeys - Number(count.rows[0]!.count));
      const saves = await client.query(
        `INSERT INTO ohmygame_saves
         SELECT g.game_id, $3, g.key, g.value, g.bytes, 1, g.updated_at FROM ohmygame_saves g
         WHERE g.game_id = $1 AND g.player_id = $2
           AND NOT EXISTS (SELECT 1 FROM ohmygame_saves a WHERE a.game_id = $1 AND a.player_id = $3 AND a.key = g.key)
         ORDER BY g.key LIMIT $4`,
        [gameId, guestId, account.playerId, room],
      );
      const { rows } = await client.query<{ board: string; score: number; at: string; rank_order: LeaderboardOrder; own_score: number | null; own_at: string | null }>(
        `SELECT g.board, g.score, g.at, b.rank_order, a.score AS own_score, a.at AS own_at
         FROM ohmygame_scores g
         JOIN ohmygame_boards b ON b.game_id = g.game_id AND b.board = g.board
         LEFT JOIN ohmygame_scores a ON a.game_id = g.game_id AND a.board = g.board AND a.player_id = $3
         WHERE g.game_id = $1 AND g.player_id = $2`,
        [gameId, guestId, account.playerId],
      );
      for (const row of rows) {
        const guest = { score: row.score, at: Number(row.at) };
        const own = row.own_score === null ? undefined : { score: row.own_score, at: Number(row.own_at) };
        const kept =
          !own ? guest
          : row.board.startsWith(MATCH_BOARD_PREFIX) ? { score: own.score + guest.score, at: Math.max(own.at, guest.at) }
          : better(row.rank_order, guest.score, own.score) ? guest
          : own;
        await client.query(
          `INSERT INTO ohmygame_scores VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (game_id, board, player_id) DO UPDATE SET name = $4, score = $5, at = $6, public = true`,
          [gameId, row.board, account.playerId, account.name, kept.score, kept.at],
        );
      }
      for (const table of ["ohmygame_saves", "ohmygame_scores", "ohmygame_players"])
        await client.query(`DELETE FROM ${table} WHERE game_id = $1 AND player_id = $2`, [gameId, guestId]);
      return { saves: saves.rowCount ?? 0, scores: rows.length };
    });
  }
  async deletePlayer(playerId: string) {
    await this.migrate();
    await this.transaction(async (client) => {
      for (const table of ["ohmygame_saves", "ohmygame_scores", "ohmygame_players"])
        await client.query(`DELETE FROM ${table} WHERE player_id = $1`, [playerId]);
    });
  }
  async prune(before: { guest: number; account: number }) {
    await this.migrate();
    await this.transaction(async (client) => {
      const { rows } = await client.query<{ game_id: string; player_id: string }>(
        `DELETE FROM ohmygame_players
         WHERE last_seen < CASE WHEN player_id LIKE 'guest:%' THEN $1::bigint ELSE $2::bigint END
         RETURNING game_id, player_id`,
        [before.guest, before.account],
      );
      if (!rows.length) return;
      const games = rows.map((row) => row.game_id);
      const players = rows.map((row) => row.player_id);
      for (const table of ["ohmygame_saves", "ohmygame_scores"])
        await client.query(
          `DELETE FROM ${table} t USING unnest($1::text[], $2::text[]) AS gone(game_id, player_id)
           WHERE t.game_id = gone.game_id AND t.player_id = gone.player_id`,
          [games, players],
        );
    });
  }
  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  private async order(gameId: string, board: string): Promise<LeaderboardOrder | undefined> {
    const { rows } = await this.query<{ rank_order: LeaderboardOrder }>(
      "SELECT rank_order FROM ohmygame_boards WHERE game_id = $1 AND board = $2",
      [gameId, board],
    );
    return rows[0]?.rank_order;
  }
  private async query<Row extends pg.QueryResultRow>(text: string, values: unknown[]): Promise<pg.QueryResult<Row>> {
    await this.migrate();
    return this.pool.query<Row>(text, values);
  }
  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (cause) {
      await client.query("ROLLBACK").catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }
}
