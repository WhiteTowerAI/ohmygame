import type { AssistantMessage } from "@earendil-works/pi-ai";

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

type ScanResult = {
  visible: string;
  pending: boolean;
};

/**
 * Removes thinking accidentally embedded in an assistant text block.
 *
 * Only a block at the beginning of the text is treated as leaked thinking. An
 * incomplete block is kept verbatim so a partial provider response cannot
 * silently lose user-visible text.
 */
export function normalizeAssistantText(text: string): string {
  const scanned = scanAssistantText(text);
  return scanned.pending ? text : scanned.visible;
}

export function normalizeAssistantMessage(
  message: AssistantMessage,
): AssistantMessage {
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== "text") return block;
    const text = normalizeAssistantText(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...message, content } : message;
}

/**
 * Incrementally normalizes one text block while keeping an incomplete opening
 * or closing pair out of the UI. The caller emits only the returned delta. If
 * a later scan replaces already-visible text, the caller should use `text` to
 * update the current item instead of treating the replacement as an append.
 */
export class AssistantTextStreamNormalizer {
  #raw = "";
  #visible = "";

  push(delta: string): string {
    this.#raw += delta;
    return this.#update(scanAssistantText(this.#raw));
  }

  finish(text = this.#raw): string {
    this.#raw = text;
    return this.#update({
      visible: normalizeAssistantText(text),
      pending: false,
    });
  }

  get text(): string {
    return this.#visible;
  }

  #update(next: ScanResult): string {
    // A scan can only reveal more text as the provider appends to a block. If
    // an adapter replaces the partial content, report no append delta. The
    // caller can replace its current item with `text`.
    if (!next.visible.startsWith(this.#visible)) {
      this.#visible = next.visible;
      return "";
    }
    const delta = next.visible.slice(this.#visible.length);
    this.#visible = next.visible;
    return delta;
  }
}

function scanAssistantText(text: string): ScanResult {
  let rest = text;
  let visible = "";
  let removedThinking = false;

  while (true) {
    const opening = rest.match(/^(\s*)<thinking>/);
    if (!opening) {
      const trimmed = rest.replace(/^\s*/, "");
      if (trimmed.length > 0 && THINKING_OPEN.startsWith(trimmed))
        return { visible, pending: true };
      if (rest.length === 0) return { visible, pending: false };
      if (trimmed.length === 0)
        return { visible: `${visible}${rest}`, pending: !removedThinking };
      return { visible: `${visible}${rest}`, pending: false };
    }

    const close = rest.indexOf(THINKING_CLOSE, opening[0].length);
    if (close < 0) return { visible, pending: true };
    removedThinking = true;
    rest = rest.slice(close + THINKING_CLOSE.length);
  }
}
