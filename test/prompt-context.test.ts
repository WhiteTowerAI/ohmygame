import { describe, expect, it } from "vitest";
import { promptContextBlock, promptContextLabels, splitPromptContext, withProjectDesignContext } from "../src/daemon/prompt-context.js";

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

  it("refreshes project metadata while preserving explicit snapshots and attachments", () => {
    const design = { kind: "design-document" as const, label: "Sky garden (abc123)", text: "Saved snapshot" };
    const attachments = "\n\n<local-attachments>\n{}\n</local-attachments>";
    const original = `${attachments}${promptContextBlock([...contexts, design], "Old revision")}`;
    const refreshed = withProjectDesignContext(original, "New revision");

    expect(refreshed).toContain(attachments);
    expect(refreshed).toContain("Saved snapshot");
    expect(refreshed).toContain('"projectDesign":"New revision"');
    expect(refreshed).not.toContain("Old revision");
    expect(promptContextLabels(refreshed)).toEqual([...contexts, design].map(({ kind, label }) => ({ kind, label })));
    expect(promptContextLabels(promptContextBlock([], "Automatic metadata"))).toEqual([]);
  });
});
