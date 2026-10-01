import { describe, expect, it } from "vitest";
import {
  createPromptHistory,
  loadHomePromptHistory,
  nextPrompt,
  previousPrompt,
  promptHistoryDirection,
  recordPrompt,
  saveHomePrompt,
} from "../src/renderer/prompt-history.js";

describe("prompt history", () => {
  it("browses older prompts and restores the current draft", () => {
    let history = createPromptHistory(["First", "Second"]);
    const second = previousPrompt(history, "Current draft")!;
    history = second.history;
    const first = previousPrompt(history, second.prompt)!;
    history = first.history;

    expect([second.prompt, first.prompt]).toEqual(["Second", "First"]);

    const newer = nextPrompt(history)!;
    const draft = nextPrompt(newer.history)!;
    expect([newer.prompt, draft.prompt]).toEqual(["Second", "Current draft"]);
  });

  it("records accepted prompts without consecutive duplicates", () => {
    let history = createPromptHistory(["First", "First", "Second"]);
    history = recordPrompt(history, " Second ");
    history = recordPrompt(history, "Third");

    expect(history.entries).toEqual(["First", "Second", "Third"]);
  });

  it("navigates only from a collapsed selection at the text boundaries", () => {
    expect(promptHistoryDirection("ArrowUp", 0, 0, 10)).toBe("previous");
    expect(promptHistoryDirection("ArrowDown", 10, 10, 10)).toBe("next");
    expect(promptHistoryDirection("ArrowUp", 5, 5, 10)).toBeUndefined();
    expect(promptHistoryDirection("ArrowDown", 5, 5, 10)).toBeUndefined();
    expect(promptHistoryDirection("ArrowUp", 0, 5, 10)).toBeUndefined();
  });

  it("treats edited history as a new draft before browsing again", () => {
    let history = createPromptHistory(["First", "Second"]);
    history = previousPrompt(history, "Draft")!.history;
    const edited = "Edited second";
    history = { ...history, index: history.entries.length, draft: edited };
    const previous = previousPrompt(history, edited)!;

    expect(previous.prompt).toBe("Second");
    expect(nextPrompt(previous.history)!.prompt).toBe(edited);
  });
});

describe("home prompt history storage", () => {
  function memoryStorage(initial?: string) {
    const values = new Map<string, string>(initial === undefined ? [] : [["ohmygame.home-prompt-history", initial]]);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
  }

  it("keeps submitted prompts oldest first and moves repeats to the end", () => {
    const storage = memoryStorage();
    saveHomePrompt({ prompt: "Make a platformer", mentions: [] }, storage);
    saveHomePrompt({ prompt: "Make a puzzle game", mentions: [] }, storage);
    saveHomePrompt({ prompt: " Make a platformer ", mentions: [] }, storage);
    saveHomePrompt({ prompt: "   ", mentions: [] }, storage);
    expect(loadHomePromptHistory(storage).map((entry) => entry.prompt)).toEqual(["Make a puzzle game", "Make a platformer"]);
  });

  it("caps the stored history", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 60; index += 1) saveHomePrompt({ prompt: `Prompt ${index}`, mentions: [] }, storage);
    const entries = loadHomePromptHistory(storage);
    expect(entries).toHaveLength(50);
    expect(entries[0]!.prompt).toBe("Prompt 10");
  });

  it("ignores unreadable or missing storage", () => {
    expect(loadHomePromptHistory(memoryStorage("not json"))).toEqual([]);
    expect(loadHomePromptHistory(memoryStorage('[{"prompt":1}]'))).toEqual([]);
    expect(loadHomePromptHistory(undefined)).toEqual([]);
    expect(() => saveHomePrompt({ prompt: "Hi", mentions: [] }, undefined)).not.toThrow();
  });
});
