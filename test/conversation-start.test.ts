import { describe, expect, it } from "vitest";
import { conversationStarters } from "../src/renderer/conversation-start.js";

describe("conversation starters", () => {
  it("offers next steps by the project's kind and whether it is going", () => {
    expect(conversationStarters("web-game", false).map((starter) => starter.label)).toEqual(["Write a design doc", "Make a prototype"]);
    expect(conversationStarters("godot-game", true).map((starter) => starter.label)).toEqual(["Playtest and fix", "Add sound", "Write a design doc"]);
    expect(conversationStarters("interactive-story", false).map((starter) => starter.id)).toEqual(["story.outline", "story.opening"]);
    expect(conversationStarters("asset-canvas", true).map((starter) => starter.id)).toEqual(["assets.set", "assets.variants"]);
    // Every starter fills the composer with a whole request, not its label.
    for (const going of [false, true]) for (const starter of conversationStarters("general", going)) expect(starter.prompt.length).toBeGreaterThan(starter.label.length);
  });
});
