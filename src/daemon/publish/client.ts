import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGlobalDispatcher, type Dispatcher } from "undici/index.js";
import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import type {
  CommunityGameStats,
  CommunityGamesQuery,
  CommunityProfile,
  CreatePublishDeploymentResult,
  PublishApiError,
  PublishDeployment,
  PublishGame,
} from "../../shared/publish-v1.js";

const UPLOAD_TIMEOUT_MS = 10 * 60_000;
// Preserve the current proxy dispatcher while allowing slow large uploads.
const uploadDispatcher: Pick<Dispatcher, "dispatch"> = {
  dispatch(options, handler) {
    return getGlobalDispatcher().dispatch({
      ...options,
      headersTimeout: UPLOAD_TIMEOUT_MS,
      bodyTimeout: UPLOAD_TIMEOUT_MS,
    }, handler);
  },
};

export interface RemotePublisherOptions {
  apiUrl: string;
  fetch?: typeof fetch;
  visitorTokenFile?: string;
}

export class RemotePublishError extends Error {
  constructor(message: string, readonly statusCode = 502, readonly code?: string) {
    super(message);
  }
}

export class RemotePublisher {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;
  readonly #visitorTokenFile?: string;
  #visitorToken?: string;
  #visitorLoaded?: Promise<void>;
  #visitorCreating?: Promise<string>;
  #visitorClearing?: Promise<void>;
  #visitorMerging?: { visitor: string; accessToken: string; promise: Promise<void> };

  constructor(options: RemotePublisherOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#visitorTokenFile = options.visitorTokenFile;
  }

  async publish(project: ProjectState, artifact: Buffer, accessToken: string, metadata: { title: string; description?: string }): Promise<PublishResult> {
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const game = await this.#game(project, metadata, accessToken);
    const created = await this.#createDeployment(project, game.id, artifact, artifactSha256, accessToken);
    if (!project.publication || project.publication.gameId !== game.id) await this.#listGame(game.id, accessToken);
    return publishResult(created.game, created.deployment);
  }

  async community(metrics = false, accessToken?: string, options: CommunityGamesQuery = {}): Promise<CommunityGame[]> {
    const query = new URLSearchParams();
    if (metrics) query.set("metrics", "true");
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.excludeGameId) query.set("excludeGameId", options.excludeGameId);
    return metrics ? this.#communityRequest(`/v1/community/games?${query}`, {}, accessToken)
      : this.#request(`/v1/community/games${query.size ? `?${query}` : ""}`, {}, accessToken);
  }

  async communityGame(gameId: string, metrics = false, accessToken?: string): Promise<CommunityGame> {
    return metrics ? this.#communityRequest(`/v1/community/games/${encodeURIComponent(gameId)}?metrics=true`, {}, accessToken)
      : this.#request(`/v1/community/games/${encodeURIComponent(gameId)}`, {}, accessToken);
  }

  async communityGameCover(gameId: string, deploymentId: string, accessToken?: string): Promise<Buffer> {
    const response = await this.#response(
      `/v1/${accessToken ? "me" : "community"}/games/${encodeURIComponent(gameId)}/deployments/${encodeURIComponent(deploymentId)}/cover`,
      {}, accessToken,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  profile(authorId: string, accessToken?: string): Promise<CommunityProfile> {
    return this.#communityRequest(`/v1/community/authors/${encodeURIComponent(authorId)}`, {}, accessToken);
  }

  myGames(accessToken: string): Promise<CommunityProfile> {
    return this.#communityRequest("/v1/me/games", {}, accessToken);
  }

  async updateCommunityGame(gameId: string, accessToken: string, metadata: { title: string; description?: string }): Promise<void> {
    await this.#request(`/v1/games/${encodeURIComponent(gameId)}`, { method: "PUT", body: JSON.stringify(metadata) }, accessToken);
  }

  setLike(gameId: string, accessToken: string | undefined, liked: boolean): Promise<CommunityGameStats> {
    return this.#communityRequest(`/v1/community/games/${encodeURIComponent(gameId)}/like`, {
      method: "PUT", body: JSON.stringify({ liked }),
    }, accessToken);
  }

  async #game(project: ProjectState, metadata: { title: string; description?: string }, accessToken: string): Promise<PublishGame> {
    let game: PublishGame;
    const gameId = project.publication?.gameId ?? (await this.#createGame(project, metadata, accessToken)).id;
    try {
      game = await this.#request<PublishGame>(`/v1/games/${gameId}`, {}, accessToken);
    } catch (error) {
      if (!(error instanceof RemotePublishError) || error.statusCode !== 404) throw error;
      game = await this.#createGame(project, metadata, accessToken);
    }
    return this.#request(`/v1/games/${game.id}`, {
      method: "PUT",
      body: JSON.stringify(metadata),
    }, accessToken);
  }

  #createGame(project: Pick<ProjectState, "id">, metadata: { title: string; description?: string }, accessToken: string): Promise<PublishGame> {
    return this.#request("/v1/games", {
      method: "POST",
      headers: { "idempotency-key": `project-${project.id}` },
      body: JSON.stringify(metadata),
    }, accessToken);
  }

  #createDeployment(
    project: Pick<ProjectState, "id" | "publication">,
    gameId: string,
    artifact: Buffer,
    artifactSha256: string,
    accessToken: string,
  ): Promise<CreatePublishDeploymentResult> {
    const metadata = {
      artifactSha256,
      artifactBytes: artifact.length,
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("artifact", new Blob([new Uint8Array(artifact)], { type: "application/zip" }), "game.zip");
    const init: RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> } = {
      method: "POST",
      headers: {
        "idempotency-key": `publish-${project.id}-${project.publication?.deploymentId ?? "initial"}-${artifactSha256}`,
      },
      body: form,
      dispatcher: uploadDispatcher,
    };
    return this.#request(`/v1/games/${gameId}/deployments`, init, accessToken, UPLOAD_TIMEOUT_MS);
  }

  async unpublish(gameId: string, accessToken: string): Promise<void> {
    await this.#request(`/v1/games/${encodeURIComponent(gameId)}`, { method: "DELETE" }, accessToken);
  }

  async #listGame(gameId: string, accessToken: string): Promise<void> {
    await this.#request(`/v1/games/${gameId}/listing`, {
      method: "PUT",
      body: JSON.stringify({ status: "listed" }),
    }, accessToken);
  }

  async #loadVisitor(): Promise<void> {
    this.#visitorLoaded ??= (async () => {
      if (!this.#visitorTokenFile) return;
      try {
        const saved = JSON.parse(await readFile(this.#visitorTokenFile, "utf8")) as { apiUrl?: string; visitorToken?: string };
        if (saved.apiUrl === this.#apiUrl && typeof saved.visitorToken === "string" && saved.visitorToken.length <= 200) this.#visitorToken = saved.visitorToken;
      } catch (cause) {
        if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    })();
    return this.#visitorLoaded;
  }

  async #ensureVisitor(): Promise<string> {
    await this.#visitorClearing;
    if (this.#visitorToken) return this.#visitorToken;
    if (!this.#visitorCreating) {
      this.#visitorCreating = (async () => {
        const session = await this.#request<{ visitorToken: string }>("/v1/community/visitor", { method: "POST" });
        if (typeof session.visitorToken !== "string" || !session.visitorToken || session.visitorToken.length > 200) throw new RemotePublishError("Invalid Community visitor response");
        if (this.#visitorTokenFile) {
          await mkdir(path.dirname(this.#visitorTokenFile), { recursive: true });
          const temporary = `${this.#visitorTokenFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify({ apiUrl: this.#apiUrl, visitorToken: session.visitorToken }), { mode: 0o600, flag: "wx" });
            await rename(temporary, this.#visitorTokenFile);
          } finally { await rm(temporary, { force: true }); }
        }
        this.#visitorToken = session.visitorToken;
        return session.visitorToken;
      })();
    }
    try { return await this.#visitorCreating; }
    finally { this.#visitorCreating = undefined; }
  }

  #forgetVisitor(visitor: string): Promise<void> {
    if (this.#visitorToken !== visitor) return Promise.resolve();
    this.#visitorToken = undefined;
    this.#visitorClearing = (this.#visitorClearing ?? Promise.resolve()).then(async () => {
      if (this.#visitorTokenFile) await rm(this.#visitorTokenFile, { force: true });
    });
    return this.#visitorClearing;
  }

  async #mergeVisitor(visitor: string, accessToken: string): Promise<void> {
    if (this.#visitorMerging?.visitor === visitor && this.#visitorMerging.accessToken === accessToken) return this.#visitorMerging.promise;
    const promise = (async () => {
      try {
        await this.#request("/v1/community/visitor/merge", { method: "POST", headers: { "x-community-visitor": visitor } }, accessToken, 5_000);
      } catch (cause) {
        if (!(cause instanceof RemotePublishError) || cause.code !== "visitor_invalid") throw cause;
      }
      await this.#forgetVisitor(visitor);
    })();
    const pending = { visitor, accessToken, promise };
    this.#visitorMerging = pending;
    try { await promise; }
    finally { if (this.#visitorMerging === pending) this.#visitorMerging = undefined; }
  }

  async #communityRequest<T>(pathname: string, init: RequestInit, accessToken?: string): Promise<T> {
    const readOnly = (init.method ?? "GET") === "GET";
    try { await this.#loadVisitor(); }
    catch (cause) { if (!readOnly) throw cause; return this.#request(pathname, init, accessToken); }
    if (accessToken) {
      if (this.#visitorToken) {
        try { await this.#mergeVisitor(this.#visitorToken, accessToken); }
        catch (cause) { if (!readOnly) throw cause; } // Preserve pending likes; reads must remain available.
      }
      return this.#request(pathname, init, accessToken);
    }
    // Public browsing never creates an identity. Existing credentials restore like state.
    if (readOnly && !this.#visitorToken) return this.#request(pathname, init);
    const visitor = await this.#ensureVisitor();
    const send = (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("x-community-visitor", token);
      return this.#request<T>(pathname, { ...init, headers }, accessToken);
    };
    try { return await send(visitor); }
    catch (cause) {
      if (!(cause instanceof RemotePublishError) || cause.code !== "visitor_invalid") throw cause;
      await this.#forgetVisitor(visitor);
      if (readOnly) return this.#request(pathname, init);
      // Only a mutation renews an expired visitor.
      return send(await this.#ensureVisitor());
    }
  }

  async #request<T>(pathname: string, init: RequestInit = {}, accessToken?: string, timeoutMs = 60_000): Promise<T> {
    const response = await this.#response(pathname, init, accessToken, timeoutMs);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async #response(pathname: string, init: RequestInit = {}, accessToken?: string, timeoutMs = 60_000): Promise<Response> {
    const headers = new Headers(init.headers);
    if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    let response: Response | undefined;
    let networkError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.#fetch(`${this.#apiUrl}${pathname}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (![502, 503, 504].includes(response.status) || attempt === 1) break;
        await response.arrayBuffer();
      } catch (error) {
        networkError = error;
        response = undefined;
        if (attempt === 1) break;
      }
    }
    if (!response) {
      const message = networkError instanceof Error ? networkError.message : "Could not reach the publish service";
      throw new RemotePublishError(message);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as PublishApiError | undefined;
      throw new RemotePublishError(body?.error.message ?? `Publish service returned ${response.status}`, response.status, body?.error.code);
    }
    return response;
  }
}

function publishResult(game: PublishGame, deployment: PublishDeployment): PublishResult {
  return {
    deployment,
    game: {
      id: game.id,
      title: game.title,
      description: game.description,
      deploymentId: deployment.id,
      playUrl: game.playUrl,
      ...(deployment.coverUrl ? { coverUrl: deployment.coverUrl } : {}),
      publishedAt: deployment.publishedAt,
    },
  };
}
