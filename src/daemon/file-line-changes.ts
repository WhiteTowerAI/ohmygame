import { open, mkdir, writeFile } from "node:fs/promises";
import {
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { LineChanges, ThreadItem } from "../shared/contracts.js";
import { lineDiff, type DiffLine } from "../shared/line-diff.js";

export const MAX_CHANGE_BYTES = 256 * 1024;

/** Unknown, binary and oversized content has no line count. */
export function changeText(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length > MAX_CHANGE_BYTES || bytes.includes(0))
    return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

type FileChangeMetadata = Pick<
  Extract<ThreadItem, { type: "dynamicToolCall" }>,
  "lineChanges" | "fileDiff"
>;
const MAX_PREVIEW_LINES = 300;
const MAX_PREVIEW_CHARS = 32 * 1024;

/** Pi returns a unified patch, or (in older records) a numbered display diff. */
export function fileChangeMetadata(
  details: Record<string, unknown> | undefined,
): FileChangeMetadata {
  const patch = typeof details?.patch === "string" ? details.patch : undefined;
  const diff = typeof details?.diff === "string" ? details.diff : undefined;
  const counts = { added: 0, removed: 0 };
  const hunks: DiffLine[][] = [];
  let hunk: DiffLine[] | undefined;
  let before = 0,
    after = 0,
    retained = 0,
    chars = 0,
    truncated = false;
  const append = (line: DiffLine) => {
    if (line.kind !== "same") counts[line.kind] += 1;
    if (retained >= MAX_PREVIEW_LINES || chars >= MAX_PREVIEW_CHARS) {
      truncated = true;
      return;
    }
    hunk ??= [];
    if (!hunk.length) hunks.push(hunk);
    const text = line.text.slice(0, MAX_PREVIEW_CHARS - chars);
    truncated ||= text.length < line.text.length;
    chars += text.length;
    retained += 1;
    hunk.push({ ...line, text });
  };
  let valid = patch === "" || (patch?.startsWith("--- ") ?? false);
  for (const row of (patch ?? diff ?? "").split("\n")) {
    if (patch !== undefined) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
      if (header) {
        before = Number(header[1]);
        after = Number(header[2]);
        valid = true;
        hunk = [];
      } else if (hunk && /^[ +\-]/.test(row)) {
        const kind =
          row[0] === "+" ? "added" : row[0] === "-" ? "removed" : "same";
        append({
          kind,
          text: row.slice(1),
          ...(kind !== "added" ? { before: before++ } : {}),
          ...(kind !== "removed" ? { after: after++ } : {}),
        });
      }
    } else {
      if (/^\s+\.\.\.$/.test(row)) {
        hunk = undefined;
        continue;
      }
      const match = /^([ +\-])\s*(\d+) (.*)$/.exec(row);
      if (!match) continue;
      valid = true;
      const kind =
        match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "same";
      const number = Number(match[2]);
      append({
        kind,
        text: match[3],
        ...(kind !== "added" ? { before: number } : {}),
        ...(kind !== "removed"
          ? {
              after:
                kind === "added"
                  ? number
                  : number + counts.added - counts.removed,
            }
          : {}),
      });
    }
  }
  const lines = details?.lineChanges as Partial<LineChanges> | undefined;
  const lineChanges =
    lines &&
    Number.isSafeInteger(lines.added) &&
    Number.isSafeInteger(lines.removed) &&
    Number(lines.added) >= 0 &&
    Number(lines.removed) >= 0
      ? { added: Number(lines.added), removed: Number(lines.removed) }
      : valid
        ? counts
        : undefined;
  return {
    ...(lineChanges ? { lineChanges } : {}),
    ...(valid
      ? { fileDiff: { hunks, ...(truncated ? { truncated: true } : {}) } }
      : {}),
  };
}

async function readBefore(filePath: string): Promise<string | undefined> {
  try {
    const handle = await open(filePath, "r");
    try {
      const bytes = Buffer.alloc(MAX_CHANGE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return changeText(bytes.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "" : undefined;
  }
}

/** Adds display metadata inside Pi's file mutation queue, including complete rewrites. */
export function createTrackedWriteTool(
  cwd: string,
): ToolDefinition<
  ReturnType<typeof createWriteToolDefinition>["parameters"],
  { patch: string } | undefined
> {
  const base = createWriteToolDefinition(cwd);
  const renderResult = base.renderResult;
  return {
    ...base,
    renderResult: renderResult
      ? (result, ...args) =>
          renderResult({ ...result, details: undefined }, ...args)
      : undefined,
    async execute(...args: Parameters<typeof base.execute>) {
      let patch: string | undefined;
      const tool = createWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => {
            await mkdir(dir, { recursive: true });
          },
          writeFile: async (filePath, content) => {
            const before = await readBefore(filePath);
            await writeFile(filePath, content, "utf8");
            const after = changeText(new TextEncoder().encode(content));
            if (before !== undefined && after !== undefined) {
              // Use the bounded line comparison shared with turn summaries, and
              // persist Pi's patch format so live and historical projections agree.
              patch = lineDiff(before, after)
                .map((hunk) => {
                  const left = hunk.filter((line) => line.kind !== "added");
                  const right = hunk.filter((line) => line.kind !== "removed");
                  const header = `@@ -${left[0]?.before ?? 0},${left.length} +${right[0]?.after ?? 0},${right.length} @@`;
                  const rows = hunk.map(
                    (line) =>
                      `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`,
                  );
                  return [header, ...rows].join("\n");
                })
                .join("\n");
            }
          },
        },
      });
      const result = await tool.execute(...args);
      return {
        ...result,
        details: patch !== undefined ? { patch } : undefined,
      };
    },
  };
}
