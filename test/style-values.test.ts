import { describe, expect, it } from "vitest";
// @ts-expect-error The check is a dependency-free script without type declarations.
import { compareCounts, countStyleValues } from "../scripts/check-style-values.mjs";

describe("style values check", () => {
  it("counts written-out values and leaves tokens, zeros and selectors alone", () => {
    expect(countStyleValues(`
      /* font-size: 99px in a comment */
      .a:hover { font-size: 11px; border-radius: 6px; color: #fff; box-shadow: 0 2px 4px rgb(0 0 0 / 10%); }
      .b { font-size: var(--text-sm); border-radius: var(--radius-md, 8px); color: var(--color-text); }
      .c { border-radius: 0; z-index: 3; font-weight: 600; font: 11px/1.4 Inter, sans-serif; box-shadow: none; }
      .d { --local: #123456; border-top-left-radius: 50%; }
      @media (max-width: 520px) { .e { font-weight: var(--weight-medium); } }
    `)).toEqual({ color: 3, fontSize: 2, fontWeight: 1, radius: 1, shadow: 1, zIndex: 1 });
  });

  it("fails only where a file's count grows, and notes where it shrinks", () => {
    const baseline = { "a.css": { fontSize: 2, color: 1 } };
    expect(compareCounts(baseline, { "a.css": { fontSize: 3, color: 0 }, "new.css": { radius: 1 } })).toEqual({
      grown: [
        { file: "a.css", kind: "fontSize", before: 2, now: 3 },
        { file: "new.css", kind: "radius", before: 0, now: 1 },
      ],
      shrunk: [{ file: "a.css", kind: "color", before: 1, now: 0 }],
    });
  });
});
