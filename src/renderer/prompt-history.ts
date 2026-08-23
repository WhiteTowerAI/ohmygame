export interface PromptHistory {
  entries: string[];
  index: number;
  draft: string;
}

export function promptHistoryDirection(
  key: string,
  selectionStart: number,
  selectionEnd: number,
  textLength: number,
): "previous" | "next" | undefined {
  if (selectionStart !== selectionEnd) return undefined;
  if (key === "ArrowUp" && selectionStart === 0) return "previous";
  if (key === "ArrowDown" && selectionEnd === textLength) return "next";
  return undefined;
}

export function createPromptHistory(entries: string[]): PromptHistory {
  const normalized = entries.reduce<string[]>((history, entry) => appendEntry(history, entry), []);
  return { entries: normalized, index: normalized.length, draft: "" };
}

export function recordPrompt(history: PromptHistory, prompt: string): PromptHistory {
  const entries = appendEntry(history.entries, prompt);
  return { entries, index: entries.length, draft: "" };
}

export function previousPrompt(history: PromptHistory, current: string): { history: PromptHistory; prompt: string } | undefined {
  if (history.index === 0 || history.entries.length === 0) return undefined;
  const index = history.index - 1;
  return {
    history: { ...history, index, draft: history.index === history.entries.length ? current : history.draft },
    prompt: history.entries[index],
  };
}

export function nextPrompt(history: PromptHistory): { history: PromptHistory; prompt: string } | undefined {
  if (history.index === history.entries.length) return undefined;
  const index = history.index + 1;
  return {
    history: { ...history, index },
    prompt: index === history.entries.length ? history.draft : history.entries[index],
  };
}

function appendEntry(entries: string[], value: string): string[] {
  const prompt = value.trim();
  return !prompt || entries.at(-1) === prompt ? entries : [...entries, prompt];
}
