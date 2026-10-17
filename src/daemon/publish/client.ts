import { createHash } from "node:crypto";
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

export interface RemotePublisherOptions {
  apiUrl: string;
  fetch?: typeof fetch;
}

export class RemotePublishError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

export class RemotePublisher {
  readonly #apiUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: RemotePublisherOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
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
    return this.#request(`/v1/community/games${query.size ? `?${query}` : ""}`, {}, accessToken);
  }

  async communityGame(gameId: string, metrics = false, accessToken?: string): Promise<CommunityGame> {
    return this.#request(`/v1/community/games/${encodeURIComponent(gameId)}${metrics ? "?metrics=true" : ""}`, {}, accessToken);
  }

  async communityGameCover(gameId: string, deploymentId: string, accessToken?: string): Promise<Buffer> {
    const response = await this.#response(
      `/v1/${accessToken ? "me" : "community"}/games/${encodeURIComponent(gameId)}/deployments/${encodeURIComponent(deploymentId)}/cover`,
      {}, accessToken,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  profile(authorId: string, accessToken?: string): Promise<CommunityProfile> {
    return this.#request(`/v1/community/authors/${encodeURIComponent(authorId)}`, {}, accessToken);
  }

  myGames(accessToken: string): Promise<CommunityProfile> {
    return this.#request("/v1/me/games", {}, accessToken);
  }

  async updateCommunityGame(gameId: string, accessToken: string, metadata: { title: string; description?: string }): Promise<void> {
    await this.#request(`/v1/games/${encodeURIComponent(gameId)}`, { method: "PUT", body: JSON.stringify(metadata) }, accessToken);
  }

  recordView(gameId: string, visitorId: string, accessToken?: string): Promise<CommunityGameStats> {
    return this.#request(`/v1/community/games/${encodeURIComponent(gameId)}/view`, {
      method: "POST", body: JSON.stringify({ visitorId }),
    }, accessToken);
  }

  setLike(gameId: string, accessToken: string, liked: boolean): Promise<CommunityGameStats> {
    return this.#request(`/v1/community/games/${encodeURIComponent(gameId)}/like`, {
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
    return this.#request(`/v1/games/${gameId}/deployments`, {
      method: "POST",
      headers: {
        "idempotency-key": `publish-${project.id}-${project.publication?.deploymentId ?? "initial"}-${artifactSha256}`,
      },
      body: form,
    }, accessToken);
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

  async #request<T>(pathname: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
    const response = await this.#response(pathname, init, accessToken);
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async #response(pathname: string, init: RequestInit = {}, accessToken?: string): Promise<Response> {
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
          signal: AbortSignal.timeout(60_000),
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
      throw new RemotePublishError(body?.error.message ?? `Publish service returned ${response.status}`, response.status);
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
