import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetTemplateDefinition } from "../shared/asset-templates.js";
import type { PluginManifest } from "../shared/plugins.js";
import type { CommunityAuthor, CommunityStats, CommunitySubjectType, PublishAssetListing, PublishAssetMediaType, PublishCommunityListing, PublishPluginListing, PublishPluginSkill, PublishTemplateListing } from "../shared/publish-v1.js";
import { nextListingState, type ListingState } from "./listings.js";

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
  hasCover: boolean;
  publishedAt: string;
}

export interface StoredCommunityGame {
  id: string;
  title: string;
  description: string;
  deploymentId: string;
  hasCover: boolean;
  publishedAt: string;
  author: CommunityAuthor;
  stats: CommunityStats;
}

export interface StoredAsset {
  id: string;
  publisherId: string;
  title: string;
  description: string;
  mediaType: PublishAssetMediaType;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAssetRelease {
  id: string;
  assetId: string;
  artifactSha256: string;
  artifactBytes: number;
  fileName: string;
  contentType: string;
  publishedAt: string;
}

export interface StoredExploreAsset extends StoredAssetRelease {
  title: string;
  description: string;
  mediaType: PublishAssetMediaType;
  author: CommunityAuthor;
  stats: CommunityStats;
}

export interface StoredPlugin {
  id: string;
  publisherId: string;
  name: string;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPluginRelease {
  id: string;
  pluginId: string;
  version: string;
  artifactSha256: string;
  artifactBytes: number;
  manifest: PluginManifest;
  skills: PublishPluginSkill[];
  publishedAt: string;
}

export interface StoredExplorePlugin extends StoredPluginRelease {
  name: string;
  author: CommunityAuthor;
  stats: CommunityStats;
}

export interface StoredTemplate {
  id: string;
  publisherId: string;
  name: string;
  currentReleaseId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTemplateRelease {
  id: string;
  templateId: string;
  definition: AssetTemplateDefinition;
  publishedAt: string;
}

export interface StoredExploreTemplate extends StoredTemplateRelease {
  name: string;
  author: CommunityAuthor;
  stats: CommunityStats;
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
    const pluginReleaseColumns = this.#database.prepare("PRAGMA table_info(plugin_releases)").all() as Row[];
    if (!pluginReleaseColumns.some((column) => column.name === "skills_json")) {
      this.#database.exec("ALTER TABLE plugin_releases ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'");
    }
    const deploymentColumns = this.#database.prepare("PRAGMA table_info(deployments)").all() as Row[];
    if (!deploymentColumns.some((column) => column.name === "has_cover")) {
      this.#database.exec("ALTER TABLE deployments ADD COLUMN has_cover INTEGER NOT NULL DEFAULT 0");
    }
    const publisherColumns = this.#database.prepare("PRAGMA table_info(publishers)").all() as Row[];
    if (!publisherColumns.some((column) => column.name === "display_name")) {
      this.#database.exec("ALTER TABLE publishers ADD COLUMN display_name TEXT NOT NULL DEFAULT 'OpenGame Creator'");
    }
    if (!publisherColumns.some((column) => column.name === "avatar_url")) {
      this.#database.exec("ALTER TABLE publishers ADD COLUMN avatar_url TEXT");
    }
    this.#database.exec("DELETE FROM idempotency_keys WHERE response_json IS NULL");
  }

  close(): void {
    this.#database.close();
  }

  ensurePublisher(publisher: CommunityAuthor, createdAt: string): void {
    this.#database.prepare(`
      INSERT INTO publishers (id, display_name, avatar_url, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, avatar_url = excluded.avatar_url
    `).run(publisher.id, publisher.displayName, publisher.avatarUrl ?? null, createdAt);
  }

  communityViewerState(publisherId: string, type: CommunitySubjectType, id: string): { liked: boolean } | undefined {
    if (!this.#listedSubjectExists(type, id)) return undefined;
    return { liked: Boolean(this.#database.prepare(`
      SELECT 1 FROM community_likes WHERE publisher_id = ? AND subject_type = ? AND subject_id = ?
    `).get(publisherId, type, id)) };
  }

  setCommunityLike(publisherId: string, type: CommunitySubjectType, id: string, liked: boolean, now: string): CommunityStats | undefined {
    if (!this.#listedSubjectExists(type, id)) return undefined;
    if (liked) {
      this.#database.prepare(`
        INSERT INTO community_likes (publisher_id, subject_type, subject_id, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(publisherId, type, id, now);
    } else {
      this.#database.prepare(`
        DELETE FROM community_likes WHERE publisher_id = ? AND subject_type = ? AND subject_id = ?
      `).run(publisherId, type, id);
    }
    return this.#communityStats(type, id);
  }

  recordCommunityUse(publisherId: string, type: CommunitySubjectType, id: string, now: string): CommunityStats | undefined {
    if (!this.#listedSubjectExists(type, id)) return undefined;
    this.#database.prepare(`
      INSERT INTO community_usage (publisher_id, subject_type, subject_id, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(publisherId, type, id, now);
    return this.#communityStats(type, id);
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

  updateGame(publisherId: string, gameId: string, title: string, description: string, updatedAt: string): StoredGame | undefined {
    const result = this.#database.prepare(`
      UPDATE games SET title = ?, description = ?, updated_at = ?
      WHERE id = ? AND publisher_id = ?
    `).run(title, description, updatedAt, gameId, publisherId);
    return result.changes ? this.game(publisherId, gameId) : undefined;
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
    const current = this.listing(publisherId, gameId)!;
    const next = nextListingState(current, status, Boolean(game.currentDeploymentId), updatedAt);
    if (next === "not_ready") return next;
    this.#database.prepare(`
      UPDATE community_listings SET status = ?, listed_at = ?, updated_at = ? WHERE game_id = ?
    `).run(next.status, next.listedAt, next.updatedAt, gameId);
    return next.status === "listed"
      ? { gameId, status: next.status, listedAt: next.listedAt!, updatedAt: next.updatedAt }
      : { gameId, status: next.status, listedAt: null, updatedAt: next.updatedAt };
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
          (id, game_id, artifact_sha256, has_cover, published_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(deployment.id, deployment.gameId, deployment.artifactSha256, Number(deployment.hasCover), deployment.publishedAt);
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
      SELECT g.id, g.title, g.description, g.current_deployment_id, d.has_cover, d.published_at,
        p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("game", "g.id")}
      FROM games g
      JOIN publishers p ON p.id = g.publisher_id
      JOIN community_listings l ON l.game_id = g.id AND l.status = 'listed'
      JOIN deployments d ON d.id = g.current_deployment_id
      ORDER BY d.published_at DESC, g.id DESC
    `).all() as Row[]).map(communityGameFrom);
  }

  communityGame(gameId: string): StoredCommunityGame | undefined {
    const row = this.#database.prepare(`
      SELECT g.id, g.title, g.description, g.current_deployment_id, d.has_cover, d.published_at,
        p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("game", "g.id")}
      FROM games g
      JOIN publishers p ON p.id = g.publisher_id
      JOIN community_listings l ON l.game_id = g.id AND l.status = 'listed'
      JOIN deployments d ON d.id = g.current_deployment_id
      WHERE g.id = ?
    `).get(gameId) as Row | undefined;
    return row ? communityGameFrom(row) : undefined;
  }

  createAsset(
    asset: StoredAsset,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): StoredAsset {
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO assets
          (id, publisher_id, title, description, media_type, current_release_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(asset.id, asset.publisherId, asset.title, asset.description, asset.mediaType, asset.createdAt, asset.updatedAt);
      this.#database.prepare(`
        INSERT INTO asset_listings (asset_id, status, listed_at, updated_at)
        VALUES (?, 'unlisted', NULL, ?)
      `).run(asset.id, asset.createdAt);
      this.#completeIdempotency(asset.publisherId, idempotency);
    });
    return asset;
  }

  asset(publisherId: string, assetId: string): StoredAsset | undefined {
    return assetFrom(this.#database.prepare(`
      SELECT * FROM assets WHERE id = ? AND publisher_id = ?
    `).get(assetId, publisherId) as Row | undefined);
  }

  activateAssetRelease(
    publisherId: string,
    release: StoredAssetRelease,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): { asset: StoredAsset; release: StoredAssetRelease } {
    let result!: { asset: StoredAsset; release: StoredAssetRelease };
    this.#transaction(() => {
      if (!this.asset(publisherId, release.assetId)) throw new Error("Asset not found");
      this.#database.prepare(`
        INSERT INTO asset_releases
          (id, asset_id, artifact_sha256, artifact_bytes, file_name, content_type, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(release.id, release.assetId, release.artifactSha256, release.artifactBytes, release.fileName, release.contentType, release.publishedAt);
      this.#database.prepare(`
        UPDATE assets SET current_release_id = ?, updated_at = ? WHERE id = ?
      `).run(release.id, release.publishedAt, release.assetId);
      this.#completeIdempotency(publisherId, idempotency);
      result = { asset: this.asset(publisherId, release.assetId)!, release };
    });
    return result;
  }

  setAssetListing(
    publisherId: string,
    assetId: string,
    status: "listed" | "unlisted",
    updatedAt: string,
  ): PublishAssetListing | "not_ready" | undefined {
    const asset = this.asset(publisherId, assetId);
    if (!asset) return undefined;
    const row = this.#database.prepare("SELECT * FROM asset_listings WHERE asset_id = ?").get(assetId) as Row;
    const current: ListingState = {
      status: row.status === "listed" ? "listed" : "unlisted",
      listedAt: row.listed_at === null ? null : String(row.listed_at),
      updatedAt: String(row.updated_at),
    };
    const next = nextListingState(current, status, Boolean(asset.currentReleaseId), updatedAt);
    if (next === "not_ready") return next;
    this.#database.prepare(`
      UPDATE asset_listings SET status = ?, listed_at = ?, updated_at = ? WHERE asset_id = ?
    `).run(next.status, next.listedAt, next.updatedAt, assetId);
    return next.status === "listed"
      ? { assetId, status: "listed", listedAt: next.listedAt!, updatedAt: next.updatedAt }
      : { assetId, status: "unlisted", listedAt: null, updatedAt: next.updatedAt };
  }

  assetReleaseIds(): Set<string> {
    return new Set((this.#database.prepare("SELECT id FROM asset_releases").all() as Row[]).map((row) => String(row.id)));
  }

  exploreAssets(): StoredExploreAsset[] {
    return (this.#database.prepare(`
      SELECT a.title, a.description, a.media_type, r.*,
        p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("asset", "a.id")}
      FROM assets a
      JOIN publishers p ON p.id = a.publisher_id
      JOIN asset_listings l ON l.asset_id = a.id AND l.status = 'listed'
      JOIN asset_releases r ON r.id = a.current_release_id
      ORDER BY r.published_at DESC, a.id DESC
    `).all() as Row[]).map(exploreAssetFrom);
  }

  exploreAsset(assetId: string): StoredExploreAsset | undefined {
    const row = this.#database.prepare(`
      SELECT a.title, a.description, a.media_type, r.*,
        p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("asset", "a.id")}
      FROM assets a
      JOIN publishers p ON p.id = a.publisher_id
      JOIN asset_listings l ON l.asset_id = a.id AND l.status = 'listed'
      JOIN asset_releases r ON r.id = a.current_release_id
      WHERE a.id = ?
    `).get(assetId) as Row | undefined;
    return row ? exploreAssetFrom(row) : undefined;
  }

  exploreAssetRelease(assetId: string, releaseId: string): StoredAssetRelease | undefined {
    return assetReleaseFrom(this.#database.prepare(`
      SELECT r.* FROM asset_releases r
      JOIN asset_listings l ON l.asset_id = r.asset_id AND l.status = 'listed'
      WHERE r.asset_id = ? AND r.id = ?
    `).get(assetId, releaseId) as Row | undefined);
  }

  createPlugin(
    plugin: StoredPlugin,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): StoredPlugin {
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO plugins (id, publisher_id, name, current_release_id, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(plugin.id, plugin.publisherId, plugin.name, plugin.createdAt, plugin.updatedAt);
      this.#database.prepare(`
        INSERT INTO plugin_listings (plugin_id, status, listed_at, updated_at)
        VALUES (?, 'unlisted', NULL, ?)
      `).run(plugin.id, plugin.createdAt);
      this.#completeIdempotency(plugin.publisherId, idempotency);
    });
    return plugin;
  }

  plugin(publisherId: string, pluginId: string): StoredPlugin | undefined {
    return pluginFrom(this.#database.prepare(`
      SELECT * FROM plugins WHERE id = ? AND publisher_id = ?
    `).get(pluginId, publisherId) as Row | undefined);
  }

  pluginByName(name: string): StoredPlugin | undefined {
    return pluginFrom(this.#database.prepare(`
      SELECT * FROM plugins WHERE name = ?
    `).get(name) as Row | undefined);
  }

  activatePluginRelease(
    publisherId: string,
    release: StoredPluginRelease,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): { plugin: StoredPlugin; release: StoredPluginRelease } {
    let result!: { plugin: StoredPlugin; release: StoredPluginRelease };
    this.#transaction(() => {
      if (!this.plugin(publisherId, release.pluginId)) throw new Error("Plugin not found");
      this.#database.prepare(`
        INSERT INTO plugin_releases
          (id, plugin_id, version, artifact_sha256, artifact_bytes, manifest_json, skills_json, published_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(release.id, release.pluginId, release.version, release.artifactSha256, release.artifactBytes, JSON.stringify(release.manifest), JSON.stringify(release.skills), release.publishedAt);
      this.#database.prepare(`
        UPDATE plugins SET current_release_id = ?, updated_at = ? WHERE id = ?
      `).run(release.id, release.publishedAt, release.pluginId);
      this.#completeIdempotency(publisherId, idempotency);
      result = { plugin: this.plugin(publisherId, release.pluginId)!, release };
    });
    return result;
  }

  pluginVersion(pluginId: string, version: string): StoredPluginRelease | undefined {
    return pluginReleaseFrom(this.#database.prepare(`
      SELECT * FROM plugin_releases WHERE plugin_id = ? AND version = ?
    `).get(pluginId, version) as Row | undefined);
  }

  currentPluginRelease(publisherId: string, pluginId: string): StoredPluginRelease | undefined {
    return pluginReleaseFrom(this.#database.prepare(`
      SELECT r.* FROM plugin_releases r
      JOIN plugins p ON p.current_release_id = r.id
      WHERE p.id = ? AND p.publisher_id = ?
    `).get(pluginId, publisherId) as Row | undefined);
  }

  setPluginListing(
    publisherId: string,
    pluginId: string,
    status: "listed" | "unlisted",
    updatedAt: string,
  ): PublishPluginListing | "not_ready" | undefined {
    const plugin = this.plugin(publisherId, pluginId);
    if (!plugin) return undefined;
    const row = this.#database.prepare("SELECT * FROM plugin_listings WHERE plugin_id = ?").get(pluginId) as Row;
    const current: ListingState = {
      status: row.status === "listed" ? "listed" : "unlisted",
      listedAt: row.listed_at === null ? null : String(row.listed_at),
      updatedAt: String(row.updated_at),
    };
    const next = nextListingState(current, status, Boolean(plugin.currentReleaseId), updatedAt);
    if (next === "not_ready") return next;
    this.#database.prepare(`
      UPDATE plugin_listings SET status = ?, listed_at = ?, updated_at = ? WHERE plugin_id = ?
    `).run(next.status, next.listedAt, next.updatedAt, pluginId);
    return next.status === "listed"
      ? { pluginId, status: "listed", listedAt: next.listedAt!, updatedAt: next.updatedAt }
      : { pluginId, status: "unlisted", listedAt: null, updatedAt: next.updatedAt };
  }

  pluginReleaseIds(): Set<string> {
    return new Set((this.#database.prepare("SELECT id FROM plugin_releases").all() as Row[]).map((row) => String(row.id)));
  }

  explorePlugins(): StoredExplorePlugin[] {
    return (this.#database.prepare(`
      SELECT p.name, r.*, publisher.id AS author_id, publisher.display_name AS author_name,
        publisher.avatar_url AS author_avatar, ${interactionCounts("plugin", "p.id")}
      FROM plugins p
      JOIN publishers publisher ON publisher.id = p.publisher_id
      JOIN plugin_listings l ON l.plugin_id = p.id AND l.status = 'listed'
      JOIN plugin_releases r ON r.id = p.current_release_id
      ORDER BY r.published_at DESC, p.id DESC
    `).all() as Row[]).map(explorePluginFrom);
  }

  explorePlugin(pluginId: string): StoredExplorePlugin | undefined {
    const row = this.#database.prepare(`
      SELECT p.name, r.*, publisher.id AS author_id, publisher.display_name AS author_name,
        publisher.avatar_url AS author_avatar, ${interactionCounts("plugin", "p.id")}
      FROM plugins p
      JOIN publishers publisher ON publisher.id = p.publisher_id
      JOIN plugin_listings l ON l.plugin_id = p.id AND l.status = 'listed'
      JOIN plugin_releases r ON r.id = p.current_release_id
      WHERE p.id = ?
    `).get(pluginId) as Row | undefined;
    return row ? explorePluginFrom(row) : undefined;
  }

  explorePluginRelease(pluginId: string, releaseId: string): StoredPluginRelease | undefined {
    return pluginReleaseFrom(this.#database.prepare(`
      SELECT r.* FROM plugin_releases r
      JOIN plugin_listings l ON l.plugin_id = r.plugin_id AND l.status = 'listed'
      WHERE r.plugin_id = ? AND r.id = ?
    `).get(pluginId, releaseId) as Row | undefined);
  }

  createTemplate(
    template: StoredTemplate,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): StoredTemplate {
    this.#transaction(() => {
      this.#database.prepare(`
        INSERT INTO templates (id, publisher_id, name, current_release_id, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(template.id, template.publisherId, template.name, template.createdAt, template.updatedAt);
      this.#database.prepare(`
        INSERT INTO template_listings (template_id, status, listed_at, updated_at)
        VALUES (?, 'unlisted', NULL, ?)
      `).run(template.id, template.createdAt);
      this.#completeIdempotency(template.publisherId, idempotency);
    });
    return template;
  }

  template(publisherId: string, templateId: string): StoredTemplate | undefined {
    return templateFrom(this.#database.prepare(`
      SELECT * FROM templates WHERE id = ? AND publisher_id = ?
    `).get(templateId, publisherId) as Row | undefined);
  }

  activateTemplateRelease(
    publisherId: string,
    release: StoredTemplateRelease,
    idempotency: { method: string; route: string; key: string; statusCode: number; body: unknown },
  ): { template: StoredTemplate; release: StoredTemplateRelease } {
    let result!: { template: StoredTemplate; release: StoredTemplateRelease };
    this.#transaction(() => {
      if (!this.template(publisherId, release.templateId)) throw new Error("Template not found");
      this.#database.prepare(`
        INSERT INTO template_releases (id, template_id, definition_json, published_at)
        VALUES (?, ?, ?, ?)
      `).run(release.id, release.templateId, JSON.stringify(release.definition), release.publishedAt);
      this.#database.prepare(`
        UPDATE templates SET name = ?, current_release_id = ?, updated_at = ? WHERE id = ?
      `).run(release.definition.name, release.id, release.publishedAt, release.templateId);
      this.#completeIdempotency(publisherId, idempotency);
      result = { template: this.template(publisherId, release.templateId)!, release };
    });
    return result;
  }

  setTemplateListing(
    publisherId: string,
    templateId: string,
    status: "listed" | "unlisted",
    updatedAt: string,
  ): PublishTemplateListing | "not_ready" | undefined {
    const template = this.template(publisherId, templateId);
    if (!template) return undefined;
    const row = this.#database.prepare("SELECT * FROM template_listings WHERE template_id = ?").get(templateId) as Row;
    const current: ListingState = {
      status: row.status === "listed" ? "listed" : "unlisted",
      listedAt: row.listed_at === null ? null : String(row.listed_at),
      updatedAt: String(row.updated_at),
    };
    const next = nextListingState(current, status, Boolean(template.currentReleaseId), updatedAt);
    if (next === "not_ready") return next;
    this.#database.prepare(`
      UPDATE template_listings SET status = ?, listed_at = ?, updated_at = ? WHERE template_id = ?
    `).run(next.status, next.listedAt, next.updatedAt, templateId);
    return next.status === "listed"
      ? { templateId, status: "listed", listedAt: next.listedAt!, updatedAt: next.updatedAt }
      : { templateId, status: "unlisted", listedAt: null, updatedAt: next.updatedAt };
  }

  exploreTemplates(): StoredExploreTemplate[] {
    return (this.#database.prepare(`
      SELECT t.name, r.*, p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("template", "t.id")}
      FROM templates t
      JOIN publishers p ON p.id = t.publisher_id
      JOIN template_listings l ON l.template_id = t.id AND l.status = 'listed'
      JOIN template_releases r ON r.id = t.current_release_id
      ORDER BY r.published_at DESC, t.id DESC
    `).all() as Row[]).map(exploreTemplateFrom);
  }

  exploreTemplate(templateId: string): StoredExploreTemplate | undefined {
    const row = this.#database.prepare(`
      SELECT t.name, r.*, p.id AS author_id, p.display_name AS author_name, p.avatar_url AS author_avatar,
        ${interactionCounts("template", "t.id")}
      FROM templates t
      JOIN publishers p ON p.id = t.publisher_id
      JOIN template_listings l ON l.template_id = t.id AND l.status = 'listed'
      JOIN template_releases r ON r.id = t.current_release_id
      WHERE t.id = ?
    `).get(templateId) as Row | undefined;
    return row ? exploreTemplateFrom(row) : undefined;
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

  #communityStats(type: CommunitySubjectType, id: string): CommunityStats {
    const row = this.#database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM community_likes WHERE subject_type = ? AND subject_id = ?) AS likes,
        (SELECT COUNT(*) FROM community_usage WHERE subject_type = ? AND subject_id = ?) AS uses
    `).get(type, id, type, id) as Row;
    return { likes: Number(row.likes), uses: Number(row.uses) };
  }

  #listedSubjectExists(type: CommunitySubjectType, id: string): boolean {
    const queries: Record<CommunitySubjectType, string> = {
      game: "SELECT 1 FROM community_listings WHERE game_id = ? AND status = 'listed'",
      asset: "SELECT 1 FROM asset_listings WHERE asset_id = ? AND status = 'listed'",
      plugin: "SELECT 1 FROM plugin_listings WHERE plugin_id = ? AND status = 'listed'",
      template: "SELECT 1 FROM template_listings WHERE template_id = ? AND status = 'listed'",
    };
    return Boolean(this.#database.prepare(queries[type]).get(id));
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
    hasCover: Boolean(row.has_cover),
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

function assetFrom(row: Row | undefined): StoredAsset | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    publisherId: String(row.publisher_id),
    title: String(row.title),
    description: String(row.description),
    mediaType: String(row.media_type) as PublishAssetMediaType,
    currentReleaseId: row.current_release_id === null ? null : String(row.current_release_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function assetReleaseFrom(row: Row | undefined): StoredAssetRelease | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    artifactSha256: String(row.artifact_sha256),
    artifactBytes: Number(row.artifact_bytes),
    fileName: String(row.file_name),
    contentType: String(row.content_type),
    publishedAt: String(row.published_at),
  };
}

function exploreAssetFrom(row: Row): StoredExploreAsset {
  return {
    ...assetReleaseFrom(row)!,
    title: String(row.title),
    description: String(row.description),
    mediaType: String(row.media_type) as PublishAssetMediaType,
    ...communityMetadataFrom(row),
  };
}

function pluginFrom(row: Row | undefined): StoredPlugin | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    publisherId: String(row.publisher_id),
    name: String(row.name),
    currentReleaseId: row.current_release_id === null ? null : String(row.current_release_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function pluginReleaseFrom(row: Row | undefined): StoredPluginRelease | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    pluginId: String(row.plugin_id),
    version: String(row.version),
    artifactSha256: String(row.artifact_sha256),
    artifactBytes: Number(row.artifact_bytes),
    manifest: JSON.parse(String(row.manifest_json)) as PluginManifest,
    skills: JSON.parse(String(row.skills_json ?? "[]")) as PublishPluginSkill[],
    publishedAt: String(row.published_at),
  };
}

function explorePluginFrom(row: Row): StoredExplorePlugin {
  return { ...pluginReleaseFrom(row)!, name: String(row.name), ...communityMetadataFrom(row) };
}

function templateFrom(row: Row | undefined): StoredTemplate | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id), publisherId: String(row.publisher_id), name: String(row.name),
    currentReleaseId: row.current_release_id === null ? null : String(row.current_release_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function templateReleaseFrom(row: Row): StoredTemplateRelease {
  return {
    id: String(row.id), templateId: String(row.template_id),
    definition: JSON.parse(String(row.definition_json)) as AssetTemplateDefinition,
    publishedAt: String(row.published_at),
  };
}

function exploreTemplateFrom(row: Row): StoredExploreTemplate {
  return { ...templateReleaseFrom(row), name: String(row.name), ...communityMetadataFrom(row) };
}

function communityGameFrom(row: Row): StoredCommunityGame {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description),
    deploymentId: String(row.current_deployment_id),
    hasCover: Boolean(row.has_cover),
    publishedAt: String(row.published_at),
    ...communityMetadataFrom(row),
  };
}

function communityMetadataFrom(row: Row): { author: CommunityAuthor; stats: CommunityStats } {
  return {
    author: {
      id: String(row.author_id),
      displayName: String(row.author_name),
      ...(row.author_avatar ? { avatarUrl: String(row.author_avatar) } : {}),
    },
    stats: { likes: Number(row.likes), uses: Number(row.uses) },
  };
}

function interactionCounts(type: CommunitySubjectType, idExpression: string): string {
  return `(SELECT COUNT(*) FROM community_likes WHERE subject_type = '${type}' AND subject_id = ${idExpression}) AS likes,
    (SELECT COUNT(*) FROM community_usage WHERE subject_type = '${type}' AND subject_id = ${idExpression}) AS uses`;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS publishers (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT 'OpenGame Creator',
    avatar_url TEXT,
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
    has_cover INTEGER NOT NULL DEFAULT 0,
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS community_listings (
    game_id TEXT PRIMARY KEY REFERENCES games(id),
    status TEXT NOT NULL CHECK(status IN ('listed', 'unlisted')),
    listed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'audio', 'model')),
    current_release_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_releases (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    artifact_sha256 TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_listings (
    asset_id TEXT PRIMARY KEY REFERENCES assets(id),
    status TEXT NOT NULL CHECK(status IN ('listed', 'unlisted')),
    listed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    name TEXT NOT NULL,
    current_release_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(publisher_id, name)
  );

  CREATE TABLE IF NOT EXISTS plugin_releases (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL REFERENCES plugins(id),
    version TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    artifact_bytes INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    skills_json TEXT NOT NULL,
    published_at TEXT NOT NULL,
    UNIQUE(plugin_id, version)
  );

  CREATE TABLE IF NOT EXISTS plugin_listings (
    plugin_id TEXT PRIMARY KEY REFERENCES plugins(id),
    status TEXT NOT NULL CHECK(status IN ('listed', 'unlisted')),
    listed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    name TEXT NOT NULL,
    current_release_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_releases (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES templates(id),
    definition_json TEXT NOT NULL,
    published_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS template_listings (
    template_id TEXT PRIMARY KEY REFERENCES templates(id),
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

  CREATE TABLE IF NOT EXISTS community_likes (
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    subject_type TEXT NOT NULL CHECK(subject_type IN ('game', 'asset', 'plugin', 'template')),
    subject_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (publisher_id, subject_type, subject_id)
  );

  CREATE TABLE IF NOT EXISTS community_usage (
    publisher_id TEXT NOT NULL REFERENCES publishers(id),
    subject_type TEXT NOT NULL CHECK(subject_type IN ('game', 'asset', 'plugin', 'template')),
    subject_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (publisher_id, subject_type, subject_id)
  );

  CREATE INDEX IF NOT EXISTS community_likes_subject ON community_likes(subject_type, subject_id);
  CREATE INDEX IF NOT EXISTS community_usage_subject ON community_usage(subject_type, subject_id);
`;
