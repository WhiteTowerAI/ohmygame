import { createHash } from "node:crypto";
import type { CommunityGame, ProjectState, PublishResult } from "../../shared/contracts.js";
import type { PluginManifest, PluginSkillContent } from "../../shared/plugins.js";
import type {
  CommunityInteractionResult,
  CommunityStats,
  CommunitySubjectType,
  CommunityViewerState,
  CreatePublishDeploymentResult,
  CreatePublishPluginReleaseResult,
  CreatePublishTemplateReleaseResult,
  PublishExplorePlugin,
  PublishExploreTemplate,
  PublishApiError,
  PublishDeployment,
  PublishGame,
  PublishPlugin,
  PublishPluginListing,
  PublishPluginPublication,
  PublishPluginOrigin,
  PublishPluginSkill,
  PublishTemplate,
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
    await this.#list(game.id, accessToken);
    return publishResult(created.game, created.deployment);
  }

  async community(): Promise<CommunityGame[]> {
    return this.#request("/v1/community/games");
  }

  async communityGame(gameId: string): Promise<CommunityGame> {
    return this.#request(`/v1/community/games/${encodeURIComponent(gameId)}`);
  }

  async communityGameCover(gameId: string, deploymentId: string): Promise<Buffer> {
    const response = await this.#response(
      `/v1/community/games/${encodeURIComponent(gameId)}/deployments/${encodeURIComponent(deploymentId)}/cover`,
    );
    return Buffer.from(await response.arrayBuffer());
  }

  async publishPlugin(input: {
    name: string;
    manifest: PluginManifest;
    skills: PublishPluginSkill[];
    archive: Buffer;
    origin?: PublishPluginOrigin;
  }, accessToken: string): Promise<CreatePublishPluginReleaseResult> {
    const plugin = await this.#request<PublishPlugin>("/v1/plugins", {
      method: "POST",
      headers: { "idempotency-key": `plugin-${input.name}` },
      body: JSON.stringify({ name: input.name }),
    }, accessToken);
    const metadata = {
      artifactSha256: createHash("sha256").update(input.archive).digest("hex"),
      artifactBytes: input.archive.length,
      manifest: input.manifest,
      skills: input.skills,
      ...(input.origin ? { origin: input.origin } : {}),
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set("artifact", new Blob([new Uint8Array(input.archive)], { type: "application/zip" }), "plugin.zip");
    const key = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    const result = await this.#request<CreatePublishPluginReleaseResult>(`/v1/plugins/${plugin.id}/releases`, {
      method: "POST",
      headers: { "idempotency-key": `plugin-release-${plugin.id}-${key}` },
      body: form,
    }, accessToken);
    await this.#request(`/v1/plugins/${plugin.id}/listing`, {
      method: "PUT", body: JSON.stringify({ status: "listed" }),
    }, accessToken);
    return result;
  }

  explorePlugins(): Promise<PublishExplorePlugin[]> {
    return this.#request("/v1/explore/plugins");
  }

  async pluginPublication(pluginId: string, accessToken: string): Promise<PublishPluginPublication | undefined> {
    try {
      return await this.#request(`/v1/plugins/${encodeURIComponent(pluginId)}/publication`, {}, accessToken);
    } catch (cause) {
      if (cause instanceof RemotePublishError && cause.statusCode === 404) return undefined;
      throw cause;
    }
  }

  setPluginListing(pluginId: string, status: "listed" | "unlisted", accessToken: string): Promise<PublishPluginListing> {
    return this.#request(`/v1/plugins/${encodeURIComponent(pluginId)}/listing`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }, accessToken);
  }

  explorePlugin(pluginId: string): Promise<PublishExplorePlugin> {
    return this.#request(`/v1/explore/plugins/${encodeURIComponent(pluginId)}`);
  }

  async pluginContent(pluginId: string, releaseId: string): Promise<Buffer> {
    const response = await this.#response(`/v1/explore/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/content`);
    return Buffer.from(await response.arrayBuffer());
  }

  pluginSkillContent(pluginId: string, releaseId: string, skillId: string): Promise<PluginSkillContent> {
    return this.#request(`/v1/explore/plugins/${encodeURIComponent(pluginId)}/releases/${encodeURIComponent(releaseId)}/skill-content?id=${encodeURIComponent(skillId)}`);
  }

  async publishTemplate(input: {
    localId: string;
    templateId?: string;
    definition: import("../../shared/asset-templates.js").AssetTemplateDefinition;
    cover?: Buffer;
  }, accessToken: string): Promise<CreatePublishTemplateReleaseResult> {
    let template = input.templateId
      ? await this.#request<PublishTemplate>(`/v1/templates/${encodeURIComponent(input.templateId)}`, {}, accessToken).catch((error) => {
        if (error instanceof RemotePublishError && error.statusCode === 404) return undefined;
        throw error;
      })
      : undefined;
    template ??= await this.#request<PublishTemplate>("/v1/templates", {
      method: "POST",
      headers: { "idempotency-key": `template-${input.localId}` },
      body: JSON.stringify({ name: input.definition.name }),
    }, accessToken);
    const metadata = {
      definition: input.definition,
      ...(input.cover ? {
        coverSha256: createHash("sha256").update(input.cover).digest("hex"),
        coverBytes: input.cover.length,
      } : {}),
    };
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    if (input.cover) form.set("cover", new Blob([new Uint8Array(input.cover)], { type: "image/webp" }), "cover.webp");
    const key = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
    const result = await this.#request<CreatePublishTemplateReleaseResult>(`/v1/templates/${template.id}/releases`, {
      method: "POST",
      headers: { "idempotency-key": `template-release-${template.id}-${key}` },
      body: form,
    }, accessToken);
    await this.#request(`/v1/templates/${template.id}/listing`, {
      method: "PUT", body: JSON.stringify({ status: "listed" }),
    }, accessToken);
    return result;
  }

  exploreTemplates(): Promise<PublishExploreTemplate[]> {
    return this.#request("/v1/explore/templates");
  }

  async templateCover(templateId: string, releaseId: string): Promise<Buffer> {
    const response = await this.#response(`/v1/explore/templates/${encodeURIComponent(templateId)}/releases/${encodeURIComponent(releaseId)}/cover`);
    return Buffer.from(await response.arrayBuffer());
  }

  setTemplateListing(templateId: string, status: "listed" | "unlisted", accessToken: string): Promise<import("../../shared/publish-v1.js").PublishTemplateListing> {
    return this.#request(`/v1/templates/${encodeURIComponent(templateId)}/listing`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }, accessToken);
  }

  communityViewerState(type: CommunitySubjectType, id: string, accessToken: string): Promise<CommunityViewerState> {
    return this.#request(`/v1/community/${type}/${encodeURIComponent(id)}/viewer`, {}, accessToken);
  }

  setCommunityLike(type: CommunitySubjectType, id: string, liked: boolean, accessToken: string): Promise<CommunityInteractionResult> {
    return this.#request(`/v1/community/${type}/${encodeURIComponent(id)}/like`, {
      method: liked ? "PUT" : "DELETE",
    }, accessToken);
  }

  recordCommunityUse(type: CommunitySubjectType, id: string, accessToken: string): Promise<CommunityStats> {
    return this.#request(`/v1/community/${type}/${encodeURIComponent(id)}/use`, { method: "POST" }, accessToken);
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

  async #list(gameId: string, accessToken: string): Promise<void> {
    await this.#request(`/v1/games/${gameId}/listing`, {
      method: "PUT",
      body: JSON.stringify({ status: "listed" }),
    }, accessToken);
  }

  async #request<T>(pathname: string, init: RequestInit = {}, accessToken?: string): Promise<T> {
    const response = await this.#response(pathname, init, accessToken);
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
