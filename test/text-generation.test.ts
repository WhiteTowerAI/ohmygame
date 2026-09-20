import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateCreativeText } from "../src/daemon/text-generation.js";

describe("text generation", () => {
  it("generates clean text without tools or conversation state", async () => {
    const model = { provider: "provider-one", id: "model-one" };
    const completeSimple = vi.fn().mockResolvedValue(assistant("A polished image prompt."));
    const runtime = { getModel: vi.fn().mockReturnValue(model), completeSimple } as unknown as ModelRuntime;

    await expect(generateCreativeText(runtime, model, "Write a cinematic image prompt about a robot on a rooftop")).resolves.toBe("A polished image prompt.");
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({
        systemPrompt: expect.stringContaining("creative production workflow"),
        messages: [expect.objectContaining({ role: "user", content: "Write a cinematic image prompt about a robot on a rooftop" })],
      }),
      expect.objectContaining({ maxTokens: 2_000, maxRetries: 0 }),
    );
  });
});

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}
