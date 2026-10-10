export interface PromptListLine {
  indent: string;
  marker: string;
  spacing: string;
  task: string;
  content: string;
}

export function promptListLines(value: string): Array<{ text: string; list?: PromptListLine }> {
  let fence: string | undefined;
  return value.split("\n").map((text) => {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(text)?.[1];
    if (delimiter && !fence) fence = delimiter;
    else if (delimiter && fence && delimiter[0] === fence[0] && delimiter.length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(text)) fence = undefined;
    if (delimiter || fence) return { text };
    const match = /^(\s*)([-+*]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(text);
    return { text, ...(match ? { list: { indent: match[1]!, marker: match[2]!, spacing: match[3]!, task: match[4] ?? "", content: match[5]! } } : {}) };
  });
}

export function editPromptList(value: string, start: number, end: number, key: string, shift = false): { value: string; cursor: number } | undefined {
  // Plain Enter must reach the composer's submit handler, including inside lists.
  if ((key !== "Enter" && key !== "Backspace" && key !== "Tab") || (key === "Enter" && !shift)) return undefined;
  const lineStart = start === 0 ? 0 : value.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = value.indexOf("\n", start);
  const currentEnd = lineEnd < 0 ? value.length : lineEnd;
  if (end > currentEnd) return undefined;
  const list = promptListLines(value.slice(0, currentEnd)).at(-1)?.list;
  if (!list) return undefined;
  const prefixEnd = lineStart + list.indent.length + list.marker.length + list.spacing.length + list.task.length;
  const replace = (from: number, to: number, text: string) => ({ value: value.slice(0, from) + text + value.slice(to), cursor: from + text.length });
  if (key === "Enter") {
    if (!list.content.trim()) return replace(lineStart, currentEnd, "");
    if (start < prefixEnd) return undefined;
    const ordered = /^(\d+)([.)])$/.exec(list.marker);
    const marker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : list.marker;
    return replace(start, end, `\n${list.indent}${marker}${list.spacing}${list.task ? "[ ] " : ""}`);
  }
  if (key === "Backspace" && start === end && start === prefixEnd) return replace(lineStart + list.indent.length, prefixEnd, "");
  if (key === "Tab" && start === end) {
    if (!shift) return { value: value.slice(0, lineStart) + "  " + value.slice(lineStart), cursor: start + 2 };
    const removed = list.indent.startsWith("\t") ? 1 : Math.min(2, list.indent.length);
    return { value: value.slice(0, lineStart) + value.slice(lineStart + removed), cursor: start - removed };
  }
  return undefined;
}
