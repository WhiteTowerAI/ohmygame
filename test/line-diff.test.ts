import { describe, expect, it } from "vitest";
import {
  countLineChanges,
  lineDiff,
  type DiffLine,
} from "../src/shared/line-diff.js";

describe("lineDiff", () => {
  it("gives no hunks for identical texts", () => {
    expect(lineDiff("one\ntwo\n", "one\ntwo\n")).toEqual([]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("shows every line of the other side when one side is empty", () => {
    expect(lineDiff("", "one\ntwo\n")).toEqual([
      [
        { kind: "added", text: "one", after: 1 },
        { kind: "added", text: "two", after: 2 },
      ],
    ]);
    expect(lineDiff("one\ntwo\n", "")).toEqual([
      [
        { kind: "removed", text: "one", before: 1 },
        { kind: "removed", text: "two", before: 2 },
      ],
    ]);
  });

  it("keeps three lines of context after a change at the start", () => {
    const before = numbered(10);
    const after = ["first", ...before.slice(1)];

    expect(lineDiff(text(before), text(after))).toEqual([
      [
        { kind: "removed", text: "line 1", before: 1 },
        { kind: "added", text: "first", after: 1 },
        { kind: "same", text: "line 2", before: 2, after: 2 },
        { kind: "same", text: "line 3", before: 3, after: 3 },
        { kind: "same", text: "line 4", before: 4, after: 4 },
      ],
    ]);
  });

  it("keeps three lines of context before a change at the end", () => {
    const before = numbered(10);

    expect(lineDiff(text(before), text([...before, "last"]))).toEqual([
      [
        { kind: "same", text: "line 8", before: 8, after: 8 },
        { kind: "same", text: "line 9", before: 9, after: 9 },
        { kind: "same", text: "line 10", before: 10, after: 10 },
        { kind: "added", text: "last", after: 11 },
      ],
    ]);
  });

  it("numbers both sides of a change in the middle", () => {
    const before = numbered(12);
    const after = [
      ...before.slice(0, 5),
      "inserted",
      ...before.slice(5, 7),
      ...before.slice(8),
    ];

    expect(lineDiff(text(before), text(after))).toEqual([
      [
        { kind: "same", text: "line 3", before: 3, after: 3 },
        { kind: "same", text: "line 4", before: 4, after: 4 },
        { kind: "same", text: "line 5", before: 5, after: 5 },
        { kind: "added", text: "inserted", after: 6 },
        { kind: "same", text: "line 6", before: 6, after: 7 },
        { kind: "same", text: "line 7", before: 7, after: 8 },
        { kind: "removed", text: "line 8", before: 8 },
        { kind: "same", text: "line 9", before: 9, after: 9 },
        { kind: "same", text: "line 10", before: 10, after: 10 },
        { kind: "same", text: "line 11", before: 11, after: 11 },
      ],
    ]);
  });

  it("splits distant changes into two hunks and joins near ones", () => {
    const before = numbered(30);
    const distant = before.map((line, index) =>
      index === 4 || index === 24 ? `${line} changed` : line,
    );
    const hunks = lineDiff(text(before), text(distant));

    expect(hunks).toHaveLength(2);
    expect(hunks[0].map(numbers)).toEqual([
      "2:2",
      "3:3",
      "4:4",
      "5:",
      ":5",
      "6:6",
      "7:7",
      "8:8",
    ]);
    expect(hunks[1].map(numbers)).toEqual([
      "22:22",
      "23:23",
      "24:24",
      "25:",
      ":25",
      "26:26",
      "27:27",
      "28:28",
    ]);

    // Six unchanged lines between two changes are all context, so nothing is left out.
    const near = before.map((line, index) =>
      index === 4 || index === 11 ? `${line} changed` : line,
    );
    expect(lineDiff(text(before), text(near))).toHaveLength(1);
    const apart = before.map((line, index) =>
      index === 4 || index === 12 ? `${line} changed` : line,
    );
    expect(lineDiff(text(before), text(apart))).toHaveLength(2);
  });

  it("does not count a repeated line twice when the texts share their start and end", () => {
    expect(lineDiff("same\nsame\n", "same\n")).toEqual([
      [
        { kind: "same", text: "same", before: 1, after: 1 },
        { kind: "removed", text: "same", before: 2 },
      ],
    ]);
  });

  it("ignores line endings and a missing final newline", () => {
    expect(lineDiff("one\r\ntwo\r\n", "one\ntwo")).toEqual([]);
    expect(lineDiff("one\r\ntwo\r\n", "one\nthree\n")).toEqual([
      [
        { kind: "same", text: "one", before: 1, after: 1 },
        { kind: "removed", text: "two", before: 2 },
        { kind: "added", text: "three", after: 2 },
      ],
    ]);
    expect(lineDiff("one\n", "one\n\n")).toEqual([
      [
        { kind: "same", text: "one", before: 1, after: 1 },
        { kind: "added", text: "", after: 2 },
      ],
    ]);
  });

  it("finds a few changes far apart in a long file", () => {
    const before = numbered(3_000);
    const after = before.map((line, index) =>
      index === 100 || index === 2_500 ? `${line}!` : line,
    );
    const result = lineDiff(text(before), text(after));

    expect(countLineChanges(text(before), text(after))).toEqual({
      added: 2,
      removed: 2,
    });
    expect(result).toHaveLength(2);
    expect(
      result
        .flat()
        .filter((line) => line.kind !== "same")
        .map(numbers),
    ).toEqual(["101:", ":101", "2501:", ":2501"]);
  });

  it("finds a line added at the top of two texts cut at the same length", () => {
    const whole = numbered(5_000);
    const cut = (lines: string[]) => text(lines).slice(0, 20_000);
    const result = lineDiff(cut(whole), cut(["inserted", ...whole]));

    expect(result).toHaveLength(2);
    expect(result[0]?.filter((line) => line.kind !== "same")).toEqual([
      { kind: "added", text: "inserted", after: 1 },
    ]);
    // Only the last line, cut in a different place, differs at the end.
    expect(
      result[1]
        ?.filter((line) => line.kind !== "same")
        .map((line) => line.kind),
    ).toEqual(["removed", "removed", "added"]);
  });

  it("shows a very large change as removed and then added", () => {
    const size = 1_100;
    const before = [
      "start",
      ...Array.from({ length: size }, (_, index) =>
        index === 500 ? "shared" : `old ${index}`,
      ),
      "end",
    ];
    const after = [
      "start",
      ...Array.from({ length: size }, (_, index) =>
        index === 600 ? "shared" : `new ${index}`,
      ),
      "end",
    ];
    const [hunk, ...rest] = lineDiff(text(before), text(after));

    expect(rest).toEqual([]);
    expect(hunk.map((line) => line.kind).join(" ")).toBe(
      [
        "same",
        ...Array(size).fill("removed"),
        ...Array(size).fill("added"),
        "same",
      ].join(" "),
    );
    expect(hunk.at(1)).toEqual({ kind: "removed", text: "old 0", before: 2 });
    expect(hunk.at(-2)).toEqual({
      kind: "added",
      text: `new ${size - 1}`,
      after: size + 1,
    });

    // Below the limit the shared line is found.
    const smaller = lineDiff(
      text(before.slice(0, 700)),
      text(after.slice(0, 700)),
    );
    expect(
      smaller
        .flat()
        .filter((line) => line.kind === "same")
        .map((line) => line.text),
    ).toContain("shared");
  });
});

function numbered(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function text(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function numbers(line: DiffLine): string {
  return `${line.before ?? ""}:${line.after ?? ""}`;
}
