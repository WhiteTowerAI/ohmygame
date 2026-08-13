import { createHash } from "node:crypto";
import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import type {
  CreatePublishDeploymentResult,
  PublishApiError,
  PublishDeployment,
  PublishGame,
} from "../../shared/publish-v1.js";

export interface RemotePublisherOptions {
  apiUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export class RemotePublishError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
  }
}

export class RemotePublisher {
  readonly #apiUrl: string;
  readonly #token?: string;
  readonly #fetch: typeof fetch;

  constructor(options: RemotePublisherOptions) {
    this.#apiUrl = options.apiUrl.replace(/\/$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async publish(project: ProjectState, artifact: Buffer): Promise<PublishResult> {
    if (!this.#token) throw new RemotePublishError("PUBLISH_TOKEN is required to publish", 503);
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const game = await this.#game(project);
    const created = await this.#createDeployment(project, game.id, artifact, artifactSha256);
    await this.#list(game.id);
    return publishResult(created.game, created.deployment);
  }

  async community(): Promise<CommunityGame[]> {
    return this.#request("/v1/community/games");
  }

  async #game(project: ProjectState): Promise<PublishGame> {
    let game: PublishGame;
    const gameId = project.publication?.gameId ?? (await this.#createGame(project)).id;
    try {
      game = await this.#request<PublishGame>(`/v1/games/${gameId}`, {}, true);
    } catch (error) {
      if (!(error instanceof RemotePublishError) || error.statusCode !== 404) throw error;
      game = await this.#createGame(project);
    }
    return game;
  }

  #createGame(project: Pick<ProjectState, "id" | "name">): Promise<PublishGame> {
    return this.#request("/v1/games", {
      method: "POST",
      headers: { "idempotency-key": `project-${project.id}` },
      body: JSON.stringify({ title: project.name }),
    }, true);
  }

  #createDeployment(
    project: Pick<ProjectState, "id" | "publication">,
    gameId: string,
    artifact: Buffer,
    artifactSha256: string,
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
    }, true);
  }

  async #list(gameId: string): Promise<void> {
    await this.#request(`/v1/games/${gameId}/listing`, {
      method: "PUT",
      body: JSON.stringify({ status: "listed" }),
    }, true);
  }

  async #request<T>(pathname: string, init: RequestInit = {}, authenticated = false): Promise<T> {
    if (authenticated && !this.#token) throw new RemotePublishError("PUBLISH_TOKEN is required to publish", 503);
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.#token}`);
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
    return response.json() as Promise<T>;
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
      publishedAt: deployment.publishedAt,
    },
  };
}
