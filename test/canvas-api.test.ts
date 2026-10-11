import { afterEach, describe, expect, it, vi } from "vitest";
import { generateCanvasDocument, generateCanvasText, generateCanvasTable } from "../src/renderer/canvas-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("canvas generation API", () => {
  it("sends selected reasoning for both text and Markdown generation", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => Response.json({ text: "Rules" }));
    vi.stubGlobal("fetch", fetchMock);
    const model = { provider: "openai", id: "test" };
    await generateCanvasText("project", "Write", model, "high");
    await generateCanvasDocument("project", "rules", { instruction: "Revise", model, reasoningLevel: "max", revision: "1" });
    await generateCanvasTable("project", "items", { instruction: "Balance damage", model, reasoningLevel: "high", revision: "2" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project/canvas/text/generate", expect.objectContaining({ body: JSON.stringify({ instruction: "Write", model, reasoningLevel: "high" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project/canvas/documents/rules/generate", expect.objectContaining({ body: JSON.stringify({ instruction: "Revise", model, reasoningLevel: "max", revision: "1" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/projects/project/canvas/tables/items/generate", expect.objectContaining({ body: JSON.stringify({ instruction: "Balance damage", model, reasoningLevel: "high", revision: "2" }) }));
  });
  it("identifies the saved node supplying generation references", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_url: string, _options?: RequestInit) => Response.json({ text: "Rules" }));
    vi.stubGlobal("fetch", fetchMock);
    const model = { provider: "openai", id: "test" }, referenceSource = { boardId: "board", nodeId: "summary" };
    await generateCanvasText("project", "Summarize", model, "off", referenceSource);
    await generateCanvasDocument("project", "rules", { instruction: "Revise", model, revision: "1", referenceSource });
    for (const [, options] of fetchMock.mock.calls) expect(JSON.parse(options!.body as string)).toHaveProperty("referenceSource", referenceSource);
  });
});
