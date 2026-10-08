import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateCreativeText, generateDesignDocumentMarkdown } from "../src/daemon/text-generation.js";

import type { RuntimeModel } from "../src/daemon/agent.js";

const model: RuntimeModel = {
  provider: "custom-relay", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-completions", baseUrl: "https://fixture.example/v1",
  reasoning: true, thinkingLevelMap: { max: "ultra" }, input: ["text"], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("text generation", () => {
  it.each(["off", "high", "max"] as const)("passes the resolved model and %s reasoning to text and document generation", async (reasoningLevel) => {
    const completeSimple = vi.fn().mockResolvedValue(assistant("Generated text"));
    const runtime = { completeSimple } as unknown as ModelRuntime;
    await generateCreativeText(runtime, model, "Write", reasoningLevel);
    await generateDesignDocumentMarkdown(runtime, model, { id: "rules", title: "Rules", markdown: "" }, "Write", reasoningLevel);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    for (const [sentModel, , options] of completeSimple.mock.calls) {
      expect(sentModel).toBe(model);
      expect(sentModel.thinkingLevelMap.max).toBe("ultra");
      if (reasoningLevel === "off") expect(options).not.toHaveProperty("reasoning");
      else expect(options.reasoning).toBe(reasoningLevel);
    }
  });

  it("generates clean text without tools or conversation state", async () => {
    const completeSimple = vi.fn().mockResolvedValue(assistant("A polished image prompt."));
    const runtime = { completeSimple } as unknown as ModelRuntime;

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
  it("rewrites using the complete Markdown and preserves relative image context", async () => {
    const completeSimple = vi.fn().mockResolvedValue(assistant("## Rules\n\nRevised\n\n![Hero](../../assets/hero.png)"));
    const runtime = { completeSimple } as unknown as ModelRuntime;
    const document = { id: "rules", title: "Game rules", markdown: "## Rules\n\n" + "种植与探索。".repeat(3000) + "\n\n![Hero](../../assets/hero.png)" };
    await generateDesignDocumentMarkdown(runtime, model, document, "完善核心循环");
    const [, context, options] = completeSimple.mock.calls[0]!;
    expect(JSON.parse(context.messages[0].content)).toEqual({ instruction: "完善核心循环", document: { title: document.title, markdown: document.markdown } });
    expect(context.systemPrompt).toContain("Preserve sections, details, image links and relative asset paths");
    expect(options.maxTokens).toBe(12_000);
  });
  it("rejects oversized input and incomplete output instead of replacing a document with partial text", async () => {
    const completeSimple = vi.fn().mockResolvedValue({ ...assistant("Partial document"), stopReason: "length" });
    const runtime = { completeSimple } as unknown as ModelRuntime;
    const document = { id: "rules", title: "Rules", markdown: "x".repeat(128_000) };
    expect(() => generateDesignDocumentMarkdown(runtime, model, document, "Revise")).toThrow("too large");
    expect(completeSimple).not.toHaveBeenCalled();
    await expect(generateDesignDocumentMarkdown(runtime, model, { ...document, markdown: "Rules" }, "Revise")).rejects.toThrow("output limit");
  });
});

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}
