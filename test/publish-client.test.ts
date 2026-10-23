import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher, type Dispatcher } from "undici/index.js";
import { RemotePublisher, RemotePublishError } from "../src/daemon/publish/client.js";
import type { ProjectState } from "../src/shared/contracts.js";

describe("Publish v1 client contract", () => {
  it("creates, deploys, and lists a game using the hosted HTTP contract", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
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
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([60_000, 60_000, 60_000, 600_000, 60_000]);
    timeout.mockRestore();
    const dispatch = vi.spyOn(getGlobalDispatcher(), "dispatch").mockReturnValue(true);
    try {
      const init = fetcher.mock.calls[3]![1] as RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> };
      init.dispatcher.dispatch({ origin: "https://publish.ohmygame.test", path: "/", method: "POST" }, {});
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ headersTimeout: 600_000, bodyTimeout: 600_000 }), {});
    } finally { dispatch.mockRestore(); }
  });

  it("preserves listing state when publishing an existing work", async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") return Response.json({ game: { ...game(), currentDeploymentId: "deployment-2" }, deployment: deployment() });
      return Response.json({ ...game(), currentDeploymentId: "deployment-old" });
    };
    const publisher = new RemotePublisher({ apiUrl: "https://publish.ohmygame.test", fetch: fetcher });
    await publisher.publish({ ...project(), publication: { gameId: "game-1", deploymentId: "deployment-old", playUrl: "https://play.example", publishedAt: new Date(0).toISOString() } }, Buffer.from("zip"), "token", { title: "Updated" });
    expect(requests.some(request => request.url.endsWith("/listing"))).toBe(false);
    expect(requests.map(request => request.method)).toEqual(["GET", "PUT", "POST"]);
  });

  it("persists one anonymous credential across restarts and renews it after account merge", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-community-visitor-"));
    try {
      const visitorTokenFile = path.join(directory, "visitor.json");
      let sessions = 0;
      let retired = false;
      const requests: Request[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/v1/community/visitor")) return Response.json({ visitorToken: `visitor-${++sessions}` });
        if (request.url.endsWith("/v1/community/visitor/merge")) { retired = true; return new Response(null, { status: 204 }); }
        const visitor = request.headers.get("x-community-visitor");
        if (retired && visitor === "visitor-1") return Response.json({ error: { code: "visitor_invalid", message: "Expired" } }, { status: 401 });
        if (request.method === "PUT") return Response.json({ viewCount: 3, likeCount: 1, liked: true });
        return Response.json([]);
      };
      const options = { apiUrl: "https://cloud.example", fetch: fetcher, visitorTokenFile };
      const publisher = new RemotePublisher(options);
      await Promise.all([publisher.community(true), publisher.community(true)]);
      expect(sessions).toBe(0);
      await Promise.all([publisher.setLike("game-1", undefined, true), publisher.setLike("game-1", undefined, true)]);
      expect(sessions).toBe(1);
      expect(JSON.parse(await readFile(visitorTokenFile, "utf8"))).toEqual({ apiUrl: options.apiUrl, visitorToken: "visitor-1" });
      if (process.platform !== "win32") expect((await stat(visitorTokenFile)).mode & 0o777).toBe(0o600);
      const restarted = new RemotePublisher(options);
      await restarted.setLike("game-1", undefined, true);
      expect(sessions).toBe(1);
      expect(requests.at(-1)?.headers.get("authorization")).toBeNull();
      await restarted.community(true, "account-token");
      expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer account-token");
      expect(requests.at(-1)?.headers.get("x-community-visitor")).toBeNull();
      expect(requests.find(request => request.url.endsWith("/merge"))?.headers.get("x-community-visitor")).toBe("visitor-1");
      await expect(readFile(visitorTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
      await restarted.community(true);
      expect(sessions).toBe(1);
      await restarted.setLike("game-1", undefined, true);
      expect(sessions).toBe(2);
      expect(requests.at(-1)?.headers.get("x-community-visitor")).toBe("visitor-2");
      await new RemotePublisher({ ...options, apiUrl: "https://another-cloud.example" }).setLike("game-1", undefined, true);
      expect(sessions).toBe(3);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it.each([429, 502, 503])("reads the public catalog without issuing a visitor when issuance would return %s", async (status) => {
    const requests: string[] = [];
    const publisher = new RemotePublisher({ apiUrl: "https://cloud.example", fetch: async (input) => {
      requests.push(String(input));
      return String(input).endsWith("/visitor") ? Response.json({ error: { code: "unavailable", message: "Unavailable" } }, { status }) : Response.json([]);
    } });
    await expect(publisher.community(true)).resolves.toEqual([]);
    expect(requests).toEqual(["https://cloud.example/v1/community/games?metrics=true"]);
  });

  it("drops an expired visitor for public reads and renews it only for a mutation", async () => {
    let sessions = 0;
    const publisher = new RemotePublisher({ apiUrl: "https://cloud.example", fetch: async (input, init) => {
      if (String(input).endsWith("/visitor")) return Response.json({ visitorToken: `visitor-${++sessions}` });
      if (init?.method !== "PUT" && new Headers(init?.headers).has("x-community-visitor")) return Response.json({ error: { code: "visitor_invalid", message: "Expired" } }, { status: 401 });
      return Response.json(init?.method === "PUT" ? { viewCount: 0, likeCount: 1, liked: true } : []);
    } });
    await publisher.setLike("game", undefined, true);
    await expect(publisher.community(true)).resolves.toEqual([]);
    expect(sessions).toBe(1);
    await publisher.setLike("game", undefined, true);
    expect(sessions).toBe(2);
  });

  it("preserves pending likes on a failed merge, keeps reads available, and acknowledges one concurrent merge", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-merge-retry-"));
    try {
      const visitorTokenFile = path.join(directory, "visitor.json");
      let limited = true;
      let merges = 0;
      const publisher = new RemotePublisher({ apiUrl: "https://cloud.example", visitorTokenFile, fetch: async (input, init) => {
        if (String(input).endsWith("/visitor")) return Response.json({ visitorToken: "visitor-1" });
        if (String(input).endsWith("/merge")) {
          merges++;
          return limited ? Response.json({ error: { code: "rate_limited", message: "Limited" } }, { status: 429 }) : new Response(null, { status: 204 });
        }
        return Response.json(init?.method === "PUT" ? { viewCount: 0, likeCount: 1, liked: true } : []);
      } });
      await publisher.setLike("game", undefined, true);
      await expect(publisher.community(true, "account")).resolves.toEqual([]);
      await expect(publisher.myGames("account")).resolves.toEqual([]);
      expect(JSON.parse(await readFile(visitorTokenFile, "utf8")).visitorToken).toBe("visitor-1");
      limited = false;
      await Promise.all([publisher.community(true, "account"), publisher.community(true, "account")]);
      expect(merges).toBe(3); // Two failed reads, one shared successful attempt.
      await expect(readFile(visitorTokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(directory, { recursive: true, force: true }); }
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
