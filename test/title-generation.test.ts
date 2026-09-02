import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateConversationTitle, generateProjectTitle, normalizeGeneratedTitle } from "../src/daemon/title-generation.js";

describe("generated titles", () => {
  it("normalizes a generated title", () => {
    expect(normalizeGeneratedTitle('  “Build   platform game!”  ')).toBe("Build platform game");
    expect(normalizeGeneratedTitle(" ")).toBeUndefined();
    expect(normalizeGeneratedTitle("游".repeat(40))).toBe("游".repeat(36));
  });

  it("generates task and project titles with the current Pi model", async () => {
    const model = { provider: "provider-one", id: "model-one" };
    const completeSimple = vi.fn()
      .mockResolvedValueOnce(assistant("Build platform game"))
      .mockResolvedValueOnce(assistant("Platform World"));
    const runtime = {
      getModel: vi.fn().mockReturnValue(model),
      completeSimple,
    } as unknown as ModelRuntime;

    await expect(generateConversationTitle(runtime, model, "Build a platform game")).resolves.toBe("Build platform game");
    await expect(generateProjectTitle(runtime, model, "Build a platform game")).resolves.toBe("Platform World");
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(completeSimple.mock.calls[0][1]).toMatchObject({
      systemPrompt: expect.stringContaining("task title"),
      messages: [expect.objectContaining({ role: "user", content: "Build a platform game" })],
    });
    expect(completeSimple.mock.calls[1][1]).toMatchObject({
      systemPrompt: expect.stringContaining("project name"),
    });
    expect(completeSimple.mock.calls[0][2]).toMatchObject({ maxRetries: 0 });
    expect(completeSimple.mock.calls[0][2]).not.toHaveProperty("reasoning");
    expect(completeSimple.mock.calls[0][1]).not.toHaveProperty("tools");
  });

  it("ignores failed model responses", async () => {
    const model = { provider: "provider-one", id: "model-one" };
    const runtime = {
      getModel: () => model,
      completeSimple: async () => ({ role: "assistant", content: [], stopReason: "error" }),
    } as unknown as ModelRuntime;

    await expect(generateConversationTitle(runtime, model, "Build a game")).resolves.toBeUndefined();
  });
});

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}
