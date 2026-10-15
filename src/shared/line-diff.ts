import type { LineChanges } from "./contracts.js";

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
  /** Line number in the text before; an added line has none. */
  before?: number;
  /** Line number in the text after; a removed line has none. */
  after?: number;
}

/** A stretch of changed lines with the unchanged lines around it. */
export type DiffHunk = DiffLine[];

const CONTEXT_LINES = 3;
/** The most lines removed and added together that the comparison looks for. */
const MAX_EDITS = 2_000;
/** The most steps the comparison takes, so that texts of many repeated lines cannot hold it up. */
const MAX_STEPS = 20_000_000;

/**
 * Compares two texts line by line for a unified view. Each hunk holds changed
 * lines with three unchanged lines on either side; what lies between two hunks
 * is unchanged. Line endings and a missing final newline are not compared, so
 * texts that differ only in those give no hunks.
 */
export function lineDiff(before: string, after: string): DiffHunk[] {
  const left = splitLines(before);
  const right = splitLines(after);
  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  )
    start += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (
    leftEnd > start &&
    rightEnd > start &&
    left[leftEnd - 1] === right[rightEnd - 1]
  ) {
    leftEnd -= 1;
    rightEnd -= 1;
  }

  const lines: DiffLine[] = [];
  let l = 0;
  let r = 0;
  const same = () => {
    lines.push({ kind: "same", text: left[l], before: l + 1, after: r + 1 });
    l += 1;
    r += 1;
  };
  const removed = () => {
    lines.push({ kind: "removed", text: left[l], before: l + 1 });
    l += 1;
  };
  const added = () => {
    lines.push({ kind: "added", text: right[r], after: r + 1 });
    r += 1;
  };

  while (l < start) same();
  // With too many differences to look for, the middle is shown as replaced whole.
  const steps = editSteps(
    left.slice(start, leftEnd),
    right.slice(start, rightEnd),
  );
  for (const step of steps ?? [])
    if (step === "same") same();
    else if (step === "removed") removed();
    else added();
  while (l < leftEnd) removed();
  while (r < rightEnd) added();
  while (l < left.length) same();
  return hunks(lines);
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The fewest lines to remove and add to turn `left` into `right`, in order,
 * after Myers ("An O(ND) Difference Algorithm and Its Variations", 1986). For
 * each count of edits it keeps the furthest point reached on every diagonal,
 * so the work follows the number of differences rather than the length of the
 * texts. Undefined when there are more than `MAX_EDITS` differences or the
 * comparison would take more than `MAX_STEPS` steps.
 */
function editSteps(
  left: string[],
  right: string[],
): DiffLine["kind"][] | undefined {
  const n = left.length;
  const m = right.length;
  // With one side empty every line is removed or added; a difference in length is a lower bound on the edits.
  if (n === 0 || m === 0 || Math.abs(n - m) > MAX_EDITS) return undefined;
  const most = Math.min(n + m, MAX_EDITS);
  // The furthest index reached in `left` on each diagonal k = x - y, at `most + k`.
  const furthest = new Int32Array(2 * most + 3);
  // The diagonals -d to d as they stood after d edits, to walk back the way that was found.
  const trace: Int32Array[] = [];
  let taken = 0;
  for (let d = 0; d <= most; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      // An added line moves down from diagonal k + 1, a removed line right from k - 1.
      const down =
        k === -d ||
        (k !== d && furthest[most + k - 1] < furthest[most + k + 1]);
      const from = down ? furthest[most + k + 1] : furthest[most + k - 1] + 1;
      let x = from;
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      taken += 1 + x - from;
      if (taken > MAX_STEPS) return undefined;
      furthest[most + k] = x;
      if (x >= n && y >= m) {
        trace.push(furthest.slice(most - d, most + d + 1));
        return walkBack(trace, left, right);
      }
    }
    trace.push(furthest.slice(most - d, most + d + 1));
  }
  return undefined;
}

/** The steps of the path that reached the end after `trace.length - 1` edits, from the start. */
function walkBack(
  trace: Int32Array[],
  left: string[],
  right: string[],
): DiffLine["kind"][] {
  const steps: DiffLine["kind"][] = [];
  let x = left.length;
  let y = right.length;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    // After d - 1 edits the diagonals -(d - 1) to d - 1 are at indices 0 to 2d - 2.
    const before = trace[d - 1]!;
    const at = (diagonal: number) => before[diagonal + d - 1]!;
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previous = down ? k + 1 : k - 1;
    const fromX = at(previous);
    const fromY = fromX - previous;
    // The run of equal lines that followed the edit.
    const startX = down ? fromX : fromX + 1;
    while (x > startX) {
      steps.push("same");
      x -= 1;
      y -= 1;
    }
    steps.push(down ? "added" : "removed");
    x = fromX;
    y = fromY;
  }
  // Equal lines from the start, before the first edit.
  while (x > 0) {
    steps.push("same");
    x -= 1;
  }
  return steps.reverse();
}

function hunks(lines: DiffLine[]): DiffHunk[] {
  const result: DiffHunk[] = [];
  let end = 0;
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const from = Math.max(index - CONTEXT_LINES, 0);
    const to = Math.min(index + CONTEXT_LINES + 1, lines.length);
    const last = result.at(-1);
    if (last && from <= end) last.push(...lines.slice(end, to));
    else result.push(lines.slice(from, to));
    end = to;
  });
  return result;
}

/** Counts the same changed lines that the unified view displays. */
export function countLineChanges(before: string, after: string): LineChanges {
  const counts = { added: 0, removed: 0 };
  for (const hunk of lineDiff(before, after)) {
    for (const line of hunk) {
      if (line.kind !== "same") counts[line.kind] += 1;
    }
  }
  return counts;
}
