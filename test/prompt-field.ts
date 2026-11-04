import { act } from "react";
import { $createParagraphNode, $getRoot, $isElementNode, $isTextNode, type LexicalEditor } from "lexical";

/** The prompt field of a PromptBox, a Lexical editor, and ways to use it as a person would. */
export function promptField(scope: ParentNode = document): HTMLElement {
  return scope.querySelector<HTMLElement>(".prompt-editor")!;
}

function editorOf(scope: ParentNode): LexicalEditor {
  return (promptField(scope) as HTMLElement & { __lexicalEditor: LexicalEditor }).__lexicalEditor;
}

/** The field's text, each chip as its token. */
export function promptText(scope: ParentNode = document): string {
  return editorOf(scope).getEditorState().read(() => $getRoot().getTextContent());
}

/** The chips the field shows, by their visible names. */
export function promptChips(scope: ParentNode = document): string[] {
  return [...promptField(scope).querySelectorAll(".prompt-mention")].map((chip) => chip.textContent ?? "");
}

/** Replaces the field's text, as typing it would, with the caret at its end. */
export async function typePrompt(value: string, scope: ParentNode = document): Promise<void> {
  const editor = editorOf(scope);
  await act(async () => {
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const paragraph = $createParagraphNode();
      root.append(paragraph);
      paragraph.select().insertRawText(value);
    }, { discrete: true });
  });
}

/** Puts the caret at a position of the field's text, a chip counting as its token. */
export async function placeCaret(offset: number, scope: ParentNode = document): Promise<void> {
  const editor = editorOf(scope);
  await act(async () => {
    editor.update(() => {
      let remaining = offset;
      const paragraph = $getRoot().getFirstChild();
      if (!$isElementNode(paragraph)) return;
      const children = paragraph.getChildren();
      for (const [index, child] of children.entries()) {
        const length = child.getTextContentSize();
        if ($isTextNode(child) && remaining <= length) {
          child.select(remaining, remaining);
          return;
        }
        if (remaining === 0) {
          paragraph.select(index, index);
          return;
        }
        remaining -= length;
      }
      paragraph.select(children.length, children.length);
    }, { discrete: true });
  });
}

/** Presses a key in the field. */
export async function pressKey(key: string, init: KeyboardEventInit = {}, scope: ParentNode = document): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { promptField(scope).dispatchEvent(event); });
  return event;
}
