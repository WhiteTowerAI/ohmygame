import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import { LOCAL_DEBUG_ACCESS_TOKEN, LOCAL_DEBUG_USER } from "../../shared/local-debug.js";
import { PUBLISH_GAME_COVER_PATH } from "../../shared/publish-v1.js";
import { LoopbackFileServer } from "../loopback-file-server.js";
import { RemotePublishError } from "./client.js";

/** Development publications are snapshots served only for this daemon session. */
export class LocalPublisher {
  readonly #files = new LoopbackFileServer();
  readonly #games = new Map<string, CommunityGame>();
  readonly #directories = new Map<string, { gameId: string; directory: string }>();

  async publish(project: ProjectState, artifact: Buffer, accessToken: string, metadata: { title: string; description?: string }): Promise<PublishResult> {
    if (accessToken !== LOCAL_DEBUG_ACCESS_TOKEN) throw new RemotePublishError("Sign in with the local debug account", 401);
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-local-publish-"));
    let mount: { token: string; url: string } | undefined;
    try {
      await extractArtifact(artifact, directory);
      mount = await this.#files.mount(directory);
      const gameId = `local-${project.id}`;
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
      this.#games.set(gameId, {
        ...game,
        author: { id: LOCAL_DEBUG_USER.id, displayName: LOCAL_DEBUG_USER.name },
      });
      this.#directories.set(deploymentId, { gameId, directory });
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

  async community(): Promise<CommunityGame[]> {
    return [...this.#games.values()].reverse();
  }

  async communityGame(gameId: string): Promise<CommunityGame> {
    const game = this.#games.get(gameId);
    if (!game) throw new RemotePublishError("Local game not found", 404);
    return game;
  }

  async communityGameCover(gameId: string, deploymentId: string): Promise<Buffer> {
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
