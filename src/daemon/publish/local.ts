import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import { LOCAL_DEBUG_ACCESS_TOKEN, LOCAL_DEBUG_USER } from "../../shared/local-debug.js";
import { type CommunityGameStats, type CommunityGamesQuery, type CommunityProfile, type ManagedCommunityGame, PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";
import { LoopbackFileServer } from "../loopback-file-server.js";
import { RemotePublishError } from "./client.js";

interface LocalPublishedGame {
  game: CommunityGame;
  firstListedAt: string;
  updatedAt: string;
  viewers: Set<string>;
  liked: boolean;
}

/** Development publications are snapshots served only for this daemon session. */
export class LocalPublisher {
  readonly #files = new LoopbackFileServer();
  readonly #games = new Map<string, LocalPublishedGame>();
  readonly #directories = new Map<string, { gameId: string; directory: string; token: string }>();

  async publish(project: ProjectState, artifact: Buffer, accessToken: string, metadata: { title: string; description?: string }): Promise<PublishResult> {
    if (accessToken !== LOCAL_DEBUG_ACCESS_TOKEN) throw new RemotePublishError("Sign in with the local debug account", 401);
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-publish-"));
    let mount: { token: string; url: string } | undefined;
    try {
      await extractArtifact(artifact, directory);
      mount = await this.#files.mount(directory);
      const gameId = project.publication?.gameId.startsWith("local-") ? project.publication.gameId : `local-${randomUUID()}`;
      const deploymentId = `local-${randomUUID()}`;
      const playUrl = `${mount.url}index.html`;
      const cover = await readFile(path.join(directory, PUBLISH_GAME_COVER_PATH)).catch(() => undefined);
      const coverUrl = cover ? `${mount.url}${PUBLISH_GAME_COVER_PATH}` : undefined;
      const publishedAt = new Date().toISOString();
      const game = {
        id: gameId,
        title: metadata.title,
        description: metadata.description ?? "",
        deploymentId,
        playUrl,
        ...(coverUrl ? { coverUrl } : {}),
        publishedAt,
      };
      const previous = this.#games.get(gameId);
      this.#games.set(gameId, {
        game: { ...game, author: { id: LOCAL_DEBUG_USER.id, displayName: LOCAL_DEBUG_USER.name } },
        firstListedAt: previous?.firstListedAt ?? publishedAt,
        updatedAt: publishedAt,
        viewers: previous?.viewers ?? new Set<string>(),
        liked: previous?.liked ?? false,
      });
      this.#directories.set(deploymentId, { gameId, directory, token: mount.token });
      return {
        game,
        deployment: {
          id: deploymentId,
          gameId,
          artifactSha256: createHash("sha256").update(artifact).digest("hex"),
          versionUrl: playUrl,
          ...(coverUrl ? { coverUrl } : {}),
          publishedAt,
        },
      };
    } catch (cause) {
      if (mount) this.#files.unmount(mount.token);
      await rm(directory, { recursive: true, force: true });
      throw cause;
    }
  }

  async community(metrics = false, accessToken?: string, options: CommunityGamesQuery = {}): Promise<CommunityGame[]> {
    if (accessToken) this.#authorize(accessToken);
    return [...this.#games.values()].reverse()
      .filter(record => record.game.id !== options.excludeGameId)
      .slice(0, options.limit)
      .map(record => this.#publicGame(record, metrics, accessToken));
  }

  async communityGame(gameId: string, metrics = false, accessToken?: string): Promise<CommunityGame> {
    if (accessToken) this.#authorize(accessToken);
    return this.#publicGame(this.#listedGame(gameId), metrics, accessToken);
  }

  async profile(authorId: string, accessToken?: string): Promise<CommunityProfile> {
    if (accessToken) this.#authorize(accessToken);
    const records = [...this.#games.values()].reverse();
    if (authorId !== LOCAL_DEBUG_USER.id || !records.length) throw new RemotePublishError("Creator has no public games", 404);
    return this.#profile(records, accessToken);
  }

  async myGames(accessToken: string): Promise<CommunityProfile> {
    this.#authorize(accessToken);
    return this.#profile([...this.#games.values()].reverse(), accessToken);
  }

  async unpublish(gameId: string, accessToken: string): Promise<void> {
    this.#authorize(accessToken);
    this.#games.delete(gameId);
    for (const [deploymentId, deployment] of this.#directories) {
      if (deployment.gameId !== gameId) continue;
      this.#files.unmount(deployment.token);
      await rm(deployment.directory, { recursive: true, force: true });
      this.#directories.delete(deploymentId);
    }
  }

  async updateCommunityGame(gameId: string, accessToken: string, metadata: { title: string; description?: string }): Promise<void> {
    this.#authorize(accessToken);
    const record = this.#games.get(gameId);
    if (!record) throw new RemotePublishError("Local game not found", 404);
    record.game = { ...record.game, title: metadata.title.trim(), description: metadata.description?.trim() ?? "" };
    record.updatedAt = new Date().toISOString();
  }

  async recordView(gameId: string, visitorId: string, accessToken?: string): Promise<CommunityGameStats> {
    const record = this.#listedGame(gameId);
    if (accessToken) this.#authorize(accessToken);
    if (!accessToken) record.viewers.add(visitorId);
    return this.#stats(record, accessToken);
  }

  async setLike(gameId: string, accessToken: string, liked: boolean): Promise<CommunityGameStats> {
    this.#authorize(accessToken);
    const record = this.#listedGame(gameId);
    record.liked = liked;
    return this.#stats(record, accessToken);
  }

  #listedGame(gameId: string): LocalPublishedGame {
    const record = this.#games.get(gameId);
    if (!record) throw new RemotePublishError("Local game not found", 404);
    return record;
  }

  #stats(record: LocalPublishedGame, accessToken?: string): CommunityGameStats {
    return { viewerCount: record.viewers.size, likeCount: record.liked ? 1 : 0,
      ...(accessToken ? { liked: record.liked } : {}) };
  }

  #publicGame(record: LocalPublishedGame, metrics: boolean, accessToken?: string): CommunityGame {
    return { ...record.game, ...(metrics ? { stats: this.#stats(record, accessToken), firstListedAt: record.firstListedAt } : {}) };
  }

  #profile(records: LocalPublishedGame[], accessToken?: string): CommunityProfile {
    const games: ManagedCommunityGame[] = records.map(record => ({
      ...this.#publicGame(record, true, accessToken), listingStatus: "listed", updatedAt: record.updatedAt,
    }));
    return { author: { id: LOCAL_DEBUG_USER.id, displayName: LOCAL_DEBUG_USER.name },
      totalLikes: games.reduce((sum, game) => sum + (game.stats?.likeCount ?? 0), 0),
      games };
  }

  #authorize(accessToken: string): void {
    if (accessToken !== LOCAL_DEBUG_ACCESS_TOKEN) throw new RemotePublishError("Sign in with the local debug account", 401);
  }

  async communityGameCover(gameId: string, deploymentId: string, accessToken?: string): Promise<Buffer> {
    if (accessToken) this.#authorize(accessToken);
    if (!this.#games.has(gameId)) throw new RemotePublishError("Local cover not found", 404);
    const deployment = this.#directories.get(deploymentId);
    if (deployment?.gameId !== gameId) throw new RemotePublishError("Local cover not found", 404);
    return readFile(path.join(deployment.directory, PUBLISH_GAME_COVER_PATH)).catch(() => {
      throw new RemotePublishError("Local cover not found", 404);
    });
  }

  async close(): Promise<void> {
    await this.#files.close();
    await Promise.all([...this.#directories.values()].map(({ directory }) => rm(directory, { recursive: true, force: true })));
    this.#directories.clear();
    this.#games.clear();
  }
}

async function extractArtifact(artifact: Buffer, directory: string): Promise<void> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(artifact, { lazyEntries: true, validateEntrySizes: true }, (error, result) => {
      if (error || !result) reject(error ?? new Error("Invalid publish archive"));
      else resolve(result);
    });
  });
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      const target = path.resolve(directory, entry.fileName);
      const relative = path.relative(directory, target);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Invalid publish archive path");
      }
      if (entry.fileName.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zip.openReadStream(entry, (error, result) => {
          if (error || !result) reject(error ?? new Error("Could not read publish archive"));
          else resolve(result);
        });
      });
      await pipeline(stream, createWriteStream(target, { flags: "wx" }));
    }
  } finally {
    zip.close();
  }
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError); };
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError); zip.readEntry();
  });
}
