import { describe, expect, it } from "vitest";
import { promptContextBlock, promptContextLabels, splitPromptContext } from "../src/daemon/prompt-context.js";

describe("Editor prompt context", () => {
  const contexts = [
    { kind: "playable-node" as const, label: "Lobby", text: "The user has Node \"lobby\" open." },
    { kind: "playable-element" as const, label: "<button> \"Go\"", text: "Picked." },
  ];

  it("round-trips a block appended to a prompt", () => {
    const block = promptContextBlock(contexts);
    expect(block).toMatch(/^\n\n<editor-context>\n.*\n<\/editor-context>$/s);
    expect(splitPromptContext(`Make this bigger${block}`)).toEqual({ rest: "Make this bigger", block });
    expect(promptContextLabels(`\n\n<local-attachments>\n{}\n</local-attachments>${block}`)).toEqual([
      { kind: "playable-node", label: "Lobby" },
      { kind: "playable-element", label: "<button> \"Go\"" },
    ]);
  });

  it("adds nothing without contexts and ignores malformed blocks", () => {
    expect(promptContextBlock([])).toBe("");
    expect(splitPromptContext("Plain text")).toEqual({ rest: "Plain text", block: "" });
    expect(promptContextLabels("\n\n<editor-context>\nnot json\n</editor-context>")).toEqual([]);
    expect(promptContextLabels("\n\n<editor-context>\n{\"items\":[{\"kind\":\"other\",\"label\":\"x\"}]}\n</editor-context>")).toEqual([]);
  });
});
