import { describe, expect, it } from "vitest";
import {
  NATIVE_API,
  replayNativeMessages,
} from "../src/daemon/agent-runtimes/replay.js";

const native = (content: unknown[]) => ({
  role: "assistant",
  api: NATIVE_API,
  provider: "codex-cli",
  model: "gpt-6-luna",
  content,
  stopReason: "toolUse",
  timestamp: 2,
});

describe("replaying coding agent turns for OhMyGame's own agent", () => {
  it("turns a native turn into text and leaves Pi's own messages alone", () => {
    const user = { role: "user", content: "add a jump", timestamp: 1 };
    const pi = {
      role: "assistant",
      api: "anthropic-messages",
      provider: "anthropic",
      content: [{ type: "toolCall", id: "pi-1", name: "read", arguments: {} }],
    };
    const piResult = {
      role: "toolResult",
      toolCallId: "pi-1",
      content: [{ type: "text", text: "file" }],
    };
    const replayed = replayNativeMessages([
      user,
      native([
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Looking at the player." },
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { command: "grep -rn jump src" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_1",
        content: [{ type: "text", text: "src/player.ts:3: jump()" }],
        isError: false,
      },
      native([
        {
          type: "toolCall",
          id: "call_2",
          name: "edit",
          arguments: { path: "src/player.ts" },
        },
      ]),
      {
        role: "toolResult",
        toolCallId: "call_2",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        isError: true,
      },
      native([{ type: "text", text: "Done." }]),
      pi,
      piResult,
    ]);
    expect(replayed).toHaveLength(4);
    expect(replayed[0]).toBe(user);
    expect(replayed[1]).toMatchObject({
      role: "assistant",
      api: NATIVE_API,
      provider: "codex-cli",
      content: [
        {
          type: "text",
          text: [
            "Looking at the player.",
            '[Codex used bash: {"command":"grep -rn jump src"}]',
            "Result: src/player.ts:3: jump()",
            '[Codex used edit: {"path":"src/player.ts"}]',
            "Failed: [image]",
            "Done.",
          ].join("\n\n"),
        },
      ],
    });
    // Unsigned native reasoning never reaches another model.
    expect(JSON.stringify(replayed[1])).not.toContain("private reasoning");
    expect(replayed[2]).toBe(pi);
    expect(replayed[3]).toBe(piResult);
  });

  it("drops native records with nothing to say and bounds long results", () => {
    const replayed = replayNativeMessages([
      native([]),
      native([{ type: "toolCall", id: "c", name: "bash", arguments: {} }]),
      {
        role: "toolResult",
        toolCallId: "c",
        content: [{ type: "text", text: "x".repeat(5_000) }],
      },
    ]);
    expect(replayed).toHaveLength(1);
    const text = (replayed[0] as { content: Array<{ text: string }> })
      .content[0]!.text;
    expect(text.startsWith("[Codex used bash]\n\nResult: ")).toBe(true);
    expect(text.length).toBeLessThan(2_100);
    expect(replayNativeMessages([native([])])).toEqual([]);
  });
});
