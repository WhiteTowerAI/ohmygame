import { describe, expect, it, vi } from "vitest";
import { createPlaytestTool, previewUrl } from "../src/daemon/playtest-tools.js";
import type { PlaytestDriver, PlaytestRequest, PlaytestResult, PlaytestSnapshot } from "../src/shared/playtest.js";

const snapshot: PlaytestSnapshot = {
  sessionId: "session-1",
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

class FakeDriver implements PlaytestDriver {
  available = true;
  readonly requests: PlaytestRequest[] = [];
  close = vi.fn();

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

describe("playtest browser tool", () => {
  it("uses a provider-compatible object schema at the function root", () => {
    const tool = createPlaytestTool(new FakeDriver(), async () => "http://127.0.0.1:43210/");

    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters).not.toHaveProperty("anyOf");
    expect(tool.parameters.required).toContain("operation");
  });

  it("starts the current preview and opens a project-local route", async () => {
    const driver = new FakeDriver();
    const ensurePreview = vi.fn(async () => "http://127.0.0.1:43210/");
    const tool = createPlaytestTool(driver, ensurePreview);

    const result = await tool.execute("open-1", {
      operation: "open",
      path: "/level-1?difficulty=hard",
      viewport: { width: 390, height: 844 },
    }, undefined, undefined, {} as never);

    expect(ensurePreview).toHaveBeenCalledOnce();
    expect(driver.requests).toEqual([{
      operation: "open",
      url: "http://127.0.0.1:43210/level-1?difficulty=hard",
      viewport: { width: 390, height: 844 },
    }]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"score": 10') });
  });

  it("returns screenshots to the model as image content", async () => {
    const tool = createPlaytestTool(new FakeDriver(), async () => "http://127.0.0.1:43210/");

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
    const tool = createPlaytestTool(driver, async () => "http://127.0.0.1:43210/");

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("not available");
  });

  it("validates fields required by session operations", async () => {
    const tool = createPlaytestTool(new FakeDriver(), async () => "http://127.0.0.1:43210/");

    await expect(tool.execute("inspect-1", {
      operation: "inspect",
    }, undefined, undefined, {} as never)).rejects.toThrow("sessionId is required for inspect");
    await expect(tool.execute("act-1", {
      operation: "act",
      sessionId: "session-1",
    }, undefined, undefined, {} as never)).rejects.toThrow("actions are required for act");
  });
});
