import { describe, expect, it } from "vitest";
import { styleTokens } from "../src/renderer/playable-project-panels.js";

describe("Project Style panel", () => {
  it("reads custom properties in source order and skips comments", () => {
    expect(styleTokens(`
      /* --ignored: red; */
      :root {
        --color-ink: #1b1a17;
        --font-display: "Cormorant", serif;
        --space-2: calc(var(--space-1) * 2);
      }
      .button { color: var(--color-ink); }
    `)).toEqual([
      { name: "--color-ink", value: "#1b1a17" },
      { name: "--font-display", value: "\"Cormorant\", serif" },
      { name: "--space-2", value: "calc(var(--space-1) * 2)" },
    ]);
  });
});
