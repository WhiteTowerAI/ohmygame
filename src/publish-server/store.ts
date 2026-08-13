import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PublishCommunityListing } from "../shared/publish-v1.js";

export interface StoredGame {
  id: string;
  publisherId: string;
  title: string;
  description: string;
  currentDeploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDeployment {
  id: string;
  gameId: string;
  artifactSha256: string;
  publishedAt: string;
}

export interface StoredCommunityGame {
  id: string;
  title: string;
  description: string;
  deploymentId: string;
  publishedAt: string;
}

export type IdempotencyReservation =
  | { kind: "new" }
  | { kind: "pending" }
  | { kind: "conflict" }
  | { kind: "replay"; statusCode: number; body: unknown };

interface Row { [key: string]: unknown }

export class PublishStore {
  readonly #database: DatabaseSync;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.#database = new DatabaseSync(path.join(dataDirectory, "publish.sqlite"));
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#database.exec(SCHEMA);
    this.#database.exec("DELETE FROM idempotency_keys WHERE response_json IS NULL");
  }

  close(): void {
    this.#database.close();
  }

  ensurePublisher(id: string, tokenHash: string, createdAt: string): void {
    this.#database.prepare(`
      INSERT INTO publishers (id, token_hash, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash
    `).run(id, tokenHash, createdAt);
  }

  publisherForTokenHash(tokenHash: string): string | undefined {
    const row = this.#database.prepare("SELECT id FROM publishers WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    return row ? String(row.id) : undefined;
  }

  reserveIdempotency(
    publisherId: string,
    method: string,
    route: string,
    key: string,
    requestHash: string,
    createdAt: string,
  ): IdempotencyReservation {
    const existing = this.#database.prepare(`
      SELECT request_hash, status_code, response_json
      FROM idempotency_keys
      WHERE publisher_id = ? AND method = ? AND route = ? AND key = ?
    `).get(publisherId, method, route, key) as Row | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) return { kind: "conflict" };
      if (existing.response_json === null) return { kind: "pending" };
      return {
        kind: "replay",
        statusCode: Number(existing.status_code),
        body: JSON.parse(String(existing.response_json)),
      };
    }
    this.#database.prepare(`
      INSERT INTO idempotency_keys
        (publisher_id, method, route, key, request_hash, status_code, response_json, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(publisherId, method, route, key, requestHash, createdAt);
    return { kind: "new" };
  }

  releaseIdempotency(publisherId: string, method: string, route: string, key: string): void {
    this.#database.prepare(`
      DELETE FROM idempotency_keys
      WHERE publisher_id = ? AND method = ? AND route = ? AND key = ? AND response_json IS NULL
    `).run(publisherId, method, route, key);
  }

  createGame(
    gameId: string,
    publisherId: string,
    title: string,
    description: string,
    now: string,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): StoredGame {
    const game: StoredGame = {
      id: gameId,
      publisherId,
      title,
      description,
      currentDeploymentId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO games
          (id, publisher_id, title, description, current_deployment_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(game.id, publisherId, title, description, now, now);
      this.#database.prepare(`
        INSERT INTO community_listings (game_id, status, listed_at, updated_at)
        VALUES (?, 'unlisted', NULL, ?)
      `).run(game.id, now);
      this.#completeIdempotency(publisherId, idempotency);
    });
    return game;
  }

  game(publisherId: string, gameId: string): StoredGame | undefined {
    return gameFrom(this.#database.prepare(`
      SELECT * FROM games WHERE id = ? AND publisher_id = ?
    `).get(gameId, publisherId) as Row | undefined);
  }

  listing(publisherId: string, gameId: string): PublishCommunityListing | undefined {
    if (!this.game(publisherId, gameId)) return undefined;
    const row = this.#database.prepare("SELECT * FROM community_listings WHERE game_id = ?").get(gameId) as Row | undefined;
    return listingFrom(row);
  }

  setListing(
    publisherId: string,
    gameId: string,
    status: "listed" | "unlisted",
    updatedAt: string,
  ): PublishCommunityListing | "not_ready" | undefined {
    const game = this.game(publisherId, gameId);
    if (!game) return undefined;
    if (status === "listed" && !game.currentDeploymentId) return "not_ready";
    const current = this.listing(publisherId, gameId)!;
    const listedAt = status === "listed" ? current.listedAt ?? updatedAt : null;
    this.#database.prepare(`
      UPDATE community_listings SET status = ?, listed_at = ?, updated_at = ? WHERE game_id = ?
    `).run(status, listedAt, updatedAt, gameId);
    return status === "listed"
      ? { gameId, status, listedAt: listedAt!, updatedAt }
      : { gameId, status, listedAt: null, updatedAt };
  }

  activateDeployment(
    publisherId: string,
    deployment: StoredDeployment,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): { deployment: StoredDeployment; game: StoredGame } {
    let result!: { deployment: StoredDeployment; game: StoredGame };
    this.#transaction(() => {
      if (!this.game(publisherId, deployment.gameId)) throw new Error("Game not found");
      this.#database.prepare(`
        INSERT INTO deployments
          (id, game_id, artifact_sha256, published_at)
        VALUES (?, ?, ?, ?)
      `).run(deployment.id, deployment.gameId, deployment.artifactSha256, deployment.publishedAt);
      this.#database.prepare(`
        UPDATE games SET current_deployment_id = ?, updated_at = ? WHERE id = ?
      `).run(deployment.id, deployment.publishedAt, deployment.gameId);
      this.#completeIdempotency(publisherId, idempotency);
      result = {
        deployment,
        game: this.game(publisherId, deployment.gameId)!,
      };
    });
    return result;
  }

  deployment(deploymentId: string): StoredDeployment | undefined {
    const deployment = deploymentFrom(this.#database.prepare(`
      SELECT * FROM deployments WHERE id = ?
    `).get(deploymentId) as Row | undefined);
    return deployment;
  }

  deploymentIds(): Set<string> {
    return new Set((this.#database.prepare("SELECT id FROM deployments").all() as Row[])
      .map((row) => String(row.id)));
  }

  currentDeployment(gameId: string): StoredDeployment | undefined {
    const deployment = deploymentFrom(this.#database.prepare(`
      SELECT d.* FROM deployments d
      JOIN games g ON g.current_deployment_id = d.id
      WHERE g.id = ?
    `).get(gameId) as Row | undefined);
    return deployment;
  }

  communityGames(): StoredCommunityGame[] {
    return (this.#database.prepare(`
      SELECT g.id, g.title, g.description, g.current_deployment_id, d.published_at
      FROM games g
      JOIN community_listings l ON l.game_id = g.id AND l.status = 'listed'
      JOIN deployments d ON d.id = g.current_deployment_id
      ORDER BY d.published_at DESC, g.id DESC
    `).all() as Row[]).map(communityGameFrom);
  }

  communityGame(gameId: string): StoredCommunityGame | undefined {
    const row = this.#database.prepare(`
      SELECT g.id, g.title, g.description, g.current_deployment_id, d.published_at
      FROM games g
      JOIN community_listings l ON l.game_id = g.id AND l.status = 'listed'
      JOIN deployments d ON d.id = g.current_deployment_id
      WHERE g.id = ?
    `).get(gameId) as Row | undefined;
    return row ? communityGameFrom(row) : undefined;
  }

  #completeIdempotency(
    publisherId: string,
    value: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): void {
    this.#database.prepare(`
      UPDATE idempotency_keys SET status_code = ?, response_json = ?
      WHERE publisher_id = ? AND method = ? AND route = ? AND key = ? AND response_json IS NULL
    `).run(value.statusCode, JSON.stringify(value.body), publisherId, value.method, value.route, value.key);
  }

  #transaction<T>(run: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function gameFrom(row: Row | undefined): StoredGame | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    publisherId: String(row.publisher_id),
    title: String(row.title),
    description: String(row.description),
    currentDeploymentId: row.current_deployment_id === null ? null : String(row.current_deployment_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function deploymentFrom(row: Row | undefined): StoredDeployment | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    gameId: String(row.game_id),
    artifactSha256: String(row.artifact_sha256),
    publishedAt: String(row.published_at),
  };
}

function listingFrom(row: Row | undefined): PublishCommunityListing | undefined {
  if (!row) return undefined;
  const base = { gameId: String(row.game_id), updatedAt: String(row.updated_at) };
  return row.status === "listed"
    ? { ...base, status: "listed", listedAt: String(row.listed_at) }
    : { ...base, status: "unlisted", listedAt: null };
}

function communityGameFrom(row: Row): StoredCommunityGame {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    deploymentId: String(row.current_deployment_id),
    publishedAt: String(row.published_at),
  };
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS publishers (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    current_deployment_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES games(id),
    artifact_sha256 TEXT NOT NULL,
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS community_listings (
    game_id TEXT PRIMARY KEY REFERENCES games(id),
    status TEXT NOT NULL CHECK(status IN ('listed', 'unlisted')),
    listed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (publisher_id, method, route, key)
  );
`;
