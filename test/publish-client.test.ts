import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RemotePublisher, RemotePublishError } from "../src/daemon/publish/client.js";
import type { ProjectState } from "../src/shared/contracts.js";

describe("Publish v1 client contract", () => {
  it("creates, deploys, and lists a game using the hosted HTTP contract", async () => {
    const artifact = Buffer.from("zip contents");
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST" && request.url.endsWith("/v1/games")) return Response.json(game(), { status: 201 });
      if (request.method === "GET" && request.url.endsWith("/v1/games/game-1")) return Response.json(game());
      if (request.method === "PUT" && request.url.endsWith("/v1/games/game-1")) return Response.json(game());
      if (request.method === "POST" && request.url.endsWith("/v1/games/game-1/deployments")) {
        return Response.json({ game: { ...game(), currentDeploymentId: "deployment-1" }, deployment: deployment() }, { status: 201 });
      }
      if (request.method === "PUT" && request.url.endsWith("/v1/games/game-1/listing")) {
        return Response.json({ gameId: "game-1", status: "listed", listedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      }
      return Response.json({ error: { code: "not_found", message: "Not found" } }, { status: 404 });
    });
    const publisher = new RemotePublisher({ apiUrl: "https://publish.ohmygame.test/", fetch: fetcher });

    await expect(publisher.publish(project(), artifact, "access-token", { title: "Game", description: "Description" }))
      .resolves.toMatchObject({ game: { id: "game-1", deploymentId: "deployment-1" }, deployment: { id: "deployment-1" } });

    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /v1/games",
      "GET /v1/games/game-1",
      "PUT /v1/games/game-1",
      "POST /v1/games/game-1/deployments",
      "PUT /v1/games/game-1/listing",
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer access-token")).toBe(true);
    expect(requests[0]!.headers.get("idempotency-key")).toBe("project-project-1");
    const deploymentForm = await requests[3]!.formData();
    expect(JSON.parse(String(deploymentForm.get("metadata")))).toEqual({
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      artifactBytes: artifact.length,
    });
    expect((deploymentForm.get("artifact") as File).name).toBe("game.zip");
  });

  it("keeps API errors typed at the desktop boundary", async () => {
    const publisher = new RemotePublisher({
      apiUrl: "https://publish.ohmygame.test",
      fetch: async () => Response.json({ error: { code: "validation_failed", message: "Bad request" } }, { status: 400 }),
    });

    await expect(publisher.community()).rejects.toEqual(expect.objectContaining<Partial<RemotePublishError>>({
      message: "Bad request",
      statusCode: 400,
    }));
  });
});

function project(): ProjectState {
  return {
    id: "project-1",
    name: "Game",
    type: "web-game",
    updatedAt: new Date(0).toISOString(),
    workspacePath: "/tmp/project-1",
    conversations: [],
    activeConversationId: null,
    preview: { status: "waiting" },
    agent: { status: "idle" },
  } as unknown as ProjectState;
}

function game() {
  return {
    id: "game-1",
    publisherId: "publisher-1",
    title: "Game",
    description: "Description",
    playUrl: "https://g-game-1.play.ohmygame.test",
    currentDeploymentId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function deployment() {
  return {
    id: "deployment-1",
    gameId: "game-1",
    artifactSha256: "a".repeat(64),
    versionUrl: "https://d-deployment-1.play.ohmygame.test",
    publishedAt: new Date(0).toISOString(),
  };
}
