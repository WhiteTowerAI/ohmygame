import { describe, expect, it, vi } from "vitest";
import { createGameUseTool, previewUrl } from "../src/daemon/playtest-tools.js";
import { WEB_GAME_USE_CAPABILITIES, type GameRuntimeAdapter, type GameUseCapabilities, type PlaytestRequest, type PlaytestResult, type PlaytestSnapshot } from "../src/shared/playtest.js";

const snapshot: PlaytestSnapshot = {
  sessionId: "session-1",
  runtime: "web",
  capabilities: WEB_GAME_USE_CAPABILITIES,
  url: "http://127.0.0.1:43210/level-1",
  title: "Test Game",
  readyState: "complete",
  viewport: { width: 1280, height: 720 },
  elements: [],
  canvases: [{ index: 0, width: 1280, height: 720, box: { x: 0, y: 0, width: 1280, height: 720 }, visible: true }],
  logs: [],
  failedRequests: [],
  gameState: { scene: "level-1", score: 10 },
  bridgeCapabilities: ["snapshot", "reset"],
};

class FakeDriver implements GameRuntimeAdapter {
  available = true;
  readonly capabilities: GameUseCapabilities;
  readonly requests: PlaytestRequest[] = [];
  close = vi.fn();

  constructor(capabilities: GameUseCapabilities = WEB_GAME_USE_CAPABILITIES) {
    this.capabilities = capabilities;
  }

  async request(request: PlaytestRequest): Promise<PlaytestResult> {
    this.requests.push(request);
    if (request.operation === "capture") {
      return {
        operation: "capture",
        capture: {
          sessionId: request.sessionId,
          mediaType: "image/png",
          data: Buffer.from("png").toString("base64"),
          width: 1280,
          height: 720,
          analysis: { sampledPixels: 100, opaqueRatio: 1, luminanceMean: 80, luminanceVariance: 12, likelyBlank: false },
        },
      };
    }
    if (request.operation === "close" || request.operation === "closeAll") return { operation: request.operation };
    return { operation: request.operation, snapshot };
  }
}

describe("game use tool", () => {
  it("uses a provider-compatible object schema at the function root", () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters).not.toHaveProperty("anyOf");
    expect(tool.parameters.required).toContain("operation");
  });

  it("starts the current preview and opens a project-local route", async () => {
    const driver = new FakeDriver();
    const resolveOpenTarget = vi.fn(async () => ({ runtime: "web" as const, url: "http://127.0.0.1:43210/" }));
    const tool = createGameUseTool(driver, resolveOpenTarget);

    const result = await tool.execute("open-1", {
      operation: "open",
      path: "/level-1?difficulty=hard",
      viewport: { width: 390, height: 844 },
    }, undefined, undefined, {} as never);

    expect(resolveOpenTarget).toHaveBeenCalledOnce();
    expect(driver.requests).toEqual([{
      operation: "open",
      target: { runtime: "web", url: "http://127.0.0.1:43210/level-1?difficulty=hard" },
      viewport: { width: 390, height: 844 },
    }]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"score": 10') });
  });

  it("returns screenshots to the model as image content", async () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    const result = await tool.execute("capture-1", {
      operation: "capture",
      sessionId: "session-1",
    }, undefined, undefined, {} as never);

    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining('"likelyBlank": false') },
      { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("refuses routes outside the current preview origin", () => {
    expect(() => previewUrl("http://127.0.0.1:43210/", "https://example.com/game"))
      .toThrow("current project preview");
  });

  it("fails clearly when the desktop driver disconnects", async () => {
    const driver = new FakeDriver();
    driver.available = false;
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("not available");
  });

  it("validates fields required by session operations", async () => {
    const tool = createGameUseTool(new FakeDriver(), async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
    }, undefined, undefined, {} as never)).rejects.toThrow("sessionId is required for inspect");
    await expect(tool.execute("act-1", {
      operation: "act",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("actions are required for act");
  });

  it("rejects actions that the runtime does not advertise", async () => {
    const driver = new FakeDriver({ ...WEB_GAME_USE_CAPABILITIES, input: ["keyboard"], observation: ["screenshot"] });
    const tool = createGameUseTool(driver, async () => ({ runtime: "web", url: "http://127.0.0.1:43210/" }));

    await expect(tool.execute("act-unsupported", {
      operation: "act",
      sessionId: "session-1",
      actions: [{ type: "click", target: { x: 20, y: 20 } }],
    }, undefined, undefined, {} as never)).rejects.toThrow("does not support pointer input");
    expect(driver.requests).toHaveLength(0);
  });

  it("does not apply web preview paths to non-web targets", async () => {
    const driver = new FakeDriver({
      ...WEB_GAME_USE_CAPABILITIES,
      runtime: "godot",
      projectTypes: ["godot-game"],
    });
    const tool = createGameUseTool(driver, async () => ({ runtime: "godot", projectPath: "/tmp/game" }));

    await expect(tool.execute("open-godot-path", {
      operation: "open",
      path: "/level-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("path is only supported by the web game runtime");
    expect(driver.requests).toHaveLength(0);
  });
});
