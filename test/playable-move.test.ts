import { describe, expect, it } from "vitest";
import {
  parsePlayableTranslate,
  playableTranslateValue,
  setPlayableElementTranslate,
} from "../src/shared/playable-move.js";
import { playableMoveRequest } from "../src/shared/playable-chat-context.js";

const html = [
  '<main class="stage">',
  '  <h1 class="title rise" style="--delay: 0.15s">Night Train</h1>',
  '  <p class="tagline">Shanghai, 1937</p>',
  "  <button data-signal=\"start\" title='a > b' style='translate: 1cqw 2cqh; color: red'>Board</button>",
  '  <img src="a.png" alt="" />',
  "  <hr style=\"translate: 4cqw 0\">",
  "</main>",
].join("\n");

describe("setPlayableElementTranslate", () => {
  it("adds translate to an existing style and keeps its other declarations", () => {
    expect(setPlayableElementTranslate(html, { line: 2, column: 3 }, "h1", { x: 3.5, y: -2 }))
      .toContain('<h1 class="title rise" style="--delay: 0.15s; translate: 3.5cqw -2cqh">Night Train</h1>');
  });

  it("adds a style attribute when the element has none", () => {
    expect(setPlayableElementTranslate(html, { line: 3, column: 3 }, "p", { x: 0, y: 10 }))
      .toContain('<p style="translate: 0 10cqh" class="tagline">Shanghai, 1937</p>');
    expect(setPlayableElementTranslate(html, { line: 5, column: 3 }, "img", { x: 1, y: 1 }))
      .toContain('<img style="translate: 1cqw 1cqh" src="a.png" alt="" />');
  });

  it("replaces an earlier translate, reads past quoted >, and keeps the quote style", () => {
    expect(setPlayableElementTranslate(html, { line: 4, column: 3 }, "button", { x: -1.234, y: 0.005 }))
      .toContain("<button data-signal=\"start\" title='a > b' style='color: red; translate: -1.23cqw 0.01cqh'>Board</button>");
  });

  it("fills a style attribute that has no value", () => {
    expect(setPlayableElementTranslate('<p style class="x">Hi</p>', { line: 1, column: 1 }, "p", { x: 1, y: 0 }))
      .toBe('<p style="translate: 1cqw 0" class="x">Hi</p>');
  });

  it("removes the declaration, and the attribute when nothing else is left", () => {
    expect(setPlayableElementTranslate(html, { line: 4, column: 3 }, "button", { x: 0, y: 0 }))
      .toContain("<button data-signal=\"start\" title='a > b' style='color: red'>Board</button>");
    expect(setPlayableElementTranslate(html, { line: 6, column: 3 }, "hr", { x: 0.001, y: 0 }))
      .toContain("  <hr>\n");
    expect(setPlayableElementTranslate(html, { line: 3, column: 3 }, "p", { x: 0, y: 0 })).toBe(html);
  });

  it("refuses another tag and a location that is not a tag", () => {
    expect(setPlayableElementTranslate(html, { line: 2, column: 3 }, "p", { x: 1, y: 1 })).toBeUndefined();
    expect(setPlayableElementTranslate(html, { line: 2, column: 5 }, "h1", { x: 1, y: 1 })).toBeUndefined();
    expect(setPlayableElementTranslate(html, { line: 40, column: 1 }, "h1", { x: 1, y: 1 })).toBeUndefined();
  });

  it("changes nothing else", () => {
    const next = setPlayableElementTranslate(html, { line: 2, column: 3 }, "h1", { x: 1, y: 1 })!;
    expect(next.replace("; translate: 1cqw 1cqh", "")).toBe(html);
  });
});

describe("parsePlayableTranslate", () => {
  const size = { width: 1000, height: 500 };

  it("reads cqw and cqh offsets, pixels, and no offset", () => {
    expect(parsePlayableTranslate("", size)).toEqual({ x: 0, y: 0 });
    expect(parsePlayableTranslate("none", size)).toEqual({ x: 0, y: 0 });
    expect(parsePlayableTranslate("3.5cqw -2cqh", size)).toEqual({ x: 3.5, y: -2 });
    expect(parsePlayableTranslate("4cqw", size)).toEqual({ x: 4, y: 0 });
    expect(parsePlayableTranslate("0 .5cqh", size)).toEqual({ x: 0, y: 0.5 });
    expect(parsePlayableTranslate("100px 50px", size)).toEqual({ x: 10, y: 10 });
  });

  it("refuses offsets a move cannot keep", () => {
    expect(parsePlayableTranslate("-50% 0", size)).toBeUndefined();
    expect(parsePlayableTranslate("1cqh 1cqw", size)).toBeUndefined();
    expect(parsePlayableTranslate("1cqw 1cqh 2px", size)).toBeUndefined();
    expect(parsePlayableTranslate("calc(1cqw + 2px) 0", size)).toBeUndefined();
    expect(parsePlayableTranslate("5 0", size)).toBeUndefined();
  });
});

describe("playableTranslateValue", () => {
  it("rounds to hundredths and drops a zero offset", () => {
    expect(playableTranslateValue({ x: 1.236, y: -0.001 })).toBe("1.24cqw 0");
    expect(playableTranslateValue({ x: 0.004, y: -0.004 })).toBeUndefined();
  });
});

describe("playableMoveRequest", () => {
  it("asks the Agent for the offset, or to remove it", () => {
    expect(playableMoveRequest({ x: 2, y: -3 })).toContain("`translate: 2cqw -3cqh`");
    expect(playableMoveRequest({ x: 0, y: 0 })).toContain("Remove its offset");
  });
});
