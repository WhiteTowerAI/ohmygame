import { afterEach, describe, expect, it, vi } from "vitest";
import { generateCanvasDocument, generateCanvasText } from "../src/renderer/canvas-api.js";

afterEach(() => vi.unstubAllGlobals());

describe("canvas generation API", () => {
  it("sends selected reasoning for both text and Markdown generation", async () => {
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async () => Response.json({ text: "Rules" }));
    vi.stubGlobal("fetch", fetchMock);
    const model = { provider: "openai", id: "test" };
    await generateCanvasText("project", "Write", model, "high");
    await generateCanvasDocument("project", "rules", { instruction: "Revise", model, reasoningLevel: "max", revision: "1" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/projects/project/canvas/text/generate", expect.objectContaining({ body: JSON.stringify({ instruction: "Write", model, reasoningLevel: "high" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/projects/project/canvas/documents/rules/generate", expect.objectContaining({ body: JSON.stringify({ instruction: "Revise", model, reasoningLevel: "max", revision: "1" }) }));
  });
});
