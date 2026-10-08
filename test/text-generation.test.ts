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
  it.each(["off", "high", "max"] as const)("passes %s reasoning to creative and document generation", async (reasoningLevel) => {
    const { runtime, completeSimple, streamSimple } = fixture(assistant("Generated text"));
    await generateCreativeText(runtime, model, "Write", reasoningLevel);
    await generateDesignDocumentMarkdown(runtime, model, { id: "rules", title: "Rules", markdown: "" }, "Write", reasoningLevel);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(streamSimple).toHaveBeenCalledTimes(1);
    for (const [sentModel, , options] of [...completeSimple.mock.calls, ...streamSimple.mock.calls]) {
      expect(sentModel).toBe(model);
      expect(sentModel.thinkingLevelMap?.max).toBe("ultra");
      if (reasoningLevel === "off") expect(options).not.toHaveProperty("reasoning");
      else expect(options?.reasoning).toBe(reasoningLevel);
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
    const { runtime, streamSimple } = fixture(assistant("## Rules\n\nRevised\n\n![Hero](../../assets/hero.png)"));
    const document = { id: "rules", title: "Game rules", markdown: "## Rules\n\n" + "种植与探索。".repeat(3000) + "\n\n![Hero](../../assets/hero.png)" };
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "完善核心循环")).resolves.toEqual({ status: "complete", markdown: "## Rules\n\nRevised\n\n![Hero](../../assets/hero.png)" });
    const [, context, options] = streamSimple.mock.calls[0]!;
    expect(context.messages[0].content).toBe(JSON.stringify({ instruction: "完善核心循环", document: { title: document.title, markdown: document.markdown } }));
    expect(context.systemPrompt).toContain("Preserve sections, details, image links and relative asset paths");
    expect(options?.maxTokens).toBe(12_000);
  });
  it("rejects oversized input and keeps truncated output for review", async () => {
    const { runtime, streamSimple } = fixture({ ...assistant("Partial document"), stopReason: "length" });
    const document = { id: "rules", title: "Rules", markdown: "x".repeat(128_000) };
    expect(() => generateDesignDocumentMarkdown(runtime, model, document, "Revise")).toThrow("too large");
    expect(streamSimple).not.toHaveBeenCalled();
    await expect(generateDesignDocumentMarkdown(runtime, model, { ...document, markdown: "Rules" }, "Revise")).resolves.toEqual({ status: "incomplete", markdown: "Partial document", error: expect.stringContaining("output limit") });
  });
  it.each(["error", "aborted"] as const)("keeps partial text and the provider's %s reason", async (stopReason) => {
    const { runtime } = fixture({ ...assistant("## Recovered draft"), stopReason, errorMessage: "Provider connection lost" });
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toEqual({ status: "incomplete", markdown: "## Recovered draft", error: "Provider connection lost" });
  });
  it.each<{ content: ResponseMessage["content"] }>([{ content: [] }, { content: [{ type: "thinking", thinking: "Private reasoning" }] }, { content: [{ type: "toolCall", id: "1", name: "write", arguments: { markdown: "Tool content" } }] }])("does not turn non-text output into a document", async ({ content }) => {
    const { runtime } = fixture({ ...assistant(""), content });
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toMatchObject({ status: "empty", markdown: "", error: expect.stringContaining("no document text") });
  });
  it.each(["error event", "throw", "disconnect"])("recovers streamed text after %s without the final response", async (failure) => {
    const partial = assistant("## Draft\n\n正文");
    const streamSimple = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "thinking_delta", contentIndex: 0, delta: "Not Markdown", partial };
        yield { type: "text_delta", contentIndex: 1, delta: "## Draft\n", partial };
        yield { type: "text_delta", contentIndex: 1, delta: "\n正文", partial };
        if (failure === "throw") throw new Error("Connection reset");
        if (failure === "error event") yield { type: "error", reason: "error", error: { ...assistant(""), errorMessage: "Connection reset", stopReason: "error" } };
      },
    }));
    const runtime = { streamSimple } as unknown as ModelRuntime;
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toMatchObject({ status: "incomplete", markdown: "## Draft\n\n正文", error: expect.stringMatching(/Connection reset|connection ended/) });
  });
  it("reports timeout instead of a generic empty response", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("Timed out", "TimeoutError")));
    try {
      const { runtime } = fixture({ ...assistant(""), stopReason: "aborted" });
      await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toMatchObject({ status: "empty", error: expect.stringContaining("timed out") });
    } finally { timeout.mockRestore(); }
  });
  it("uses authoritative text blocks without duplicating streamed text or including thinking", async () => {
    const partial = assistant("");
    const runtime = { streamSimple: () => ({ async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: "Old text", partial };
      yield { type: "text_end", contentIndex: 0, content: "## Rules\n", partial };
      yield { type: "thinking_end", contentIndex: 1, content: "Private reasoning", partial };
      yield { type: "text_end", contentIndex: 2, content: "\n正文", partial };
      yield { type: "error", reason: "error", error: { ...partial, stopReason: "error" } };
    } }) } as unknown as ModelRuntime;
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toMatchObject({ status: "incomplete", markdown: "## Rules\n\n正文" });
  });
  it("requires review when the model asks for a tool instead of finishing", async () => {
    const { runtime } = fixture({ ...assistant("Draft"), stopReason: "toolUse" });
    await expect(generateDesignDocumentMarkdown(runtime, model, document, "Revise")).resolves.toMatchObject({ status: "incomplete", markdown: "Draft" });
  });
});

type ResponseMessage = Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
const document = { id: "rules", title: "Rules", markdown: "Original document" };
function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as ResponseMessage;
}
function fixture(message: ResponseMessage) {
  const completeSimple = vi.fn<ModelRuntime["completeSimple"]>().mockResolvedValue(message);
  const streamSimple = vi.fn<ModelRuntime["streamSimple"]>(() => ({
    async *[Symbol.asyncIterator]() {
      if (message.stopReason === "error" || message.stopReason === "aborted") yield { type: "error", reason: message.stopReason, error: message };
      else yield { type: "done", reason: message.stopReason, message };
    },
  }) as unknown as ReturnType<ModelRuntime["streamSimple"]>);
  return { runtime: { completeSimple, streamSimple } as unknown as ModelRuntime, completeSimple, streamSimple };
}
