import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateConversationTitle, normalizeGeneratedTitle } from "../src/daemon/conversation-titles.js";

describe("conversation titles", () => {
  it("normalizes a generated title", () => {
    expect(normalizeGeneratedTitle('  “Build   platform game!”  ')).toBe("Build platform game");
    expect(normalizeGeneratedTitle(" ")).toBeUndefined();
    expect(normalizeGeneratedTitle("游".repeat(40))).toBe("游".repeat(36));
  });

  it("uses Pi's current model without adding tools or conversation history", async () => {
    const model = { provider: "provider-one", id: "model-one" };
    const completeSimple = vi.fn().mockResolvedValue({
      role: "assistant",
      content: [{ type: "text", text: "Build platform game" }],
      stopReason: "stop",
    });
    const runtime = {
      getModel: vi.fn().mockReturnValue(model),
      completeSimple,
    } as unknown as ModelRuntime;

    await expect(generateConversationTitle(runtime, model, "Build a platform game")).resolves.toBe("Build platform game");
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        messages: [expect.objectContaining({ role: "user", content: "Build a platform game" })],
      }),
      expect.objectContaining({ maxRetries: 0 }),
    );
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
