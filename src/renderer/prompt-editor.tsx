import { createContext, useContext, useEffect, useImperativeHandle, useRef, type AriaAttributes, type ReactNode, type Ref } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  DecoratorNode,
  KEY_DOWN_COMMAND,
  type LexicalNode,
  type NodeKey,
  type PointType,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { pluginMentionRanges } from "../shared/plugins.js";
import { skillMentionRanges } from "../shared/skill-mentions.js";
import { skillDisplayName } from "./composer-mentions.js";
import { WandSparkles } from "./icons.js";
import { PluginMentionGlyph } from "./plugin-icons.js";

/** What a parent can do with the field, in positions of its text. */
export interface PromptInput {
  /** Focuses the field, with the caret at `cursor` when given. */
  focus(cursor?: number): void;
  /** Whether a node is the field or inside it. */
  contains(node: Node | null): boolean;
}

export interface PromptSelection {
  start: number;
  end: number;
}

type Mention =
  | { kind: "plugin"; token: string; mention: PluginMention }
  | { kind: "skill"; token: string; name: string };

type SerializedMentionNode = Spread<{ mention: Mention }, SerializedLexicalNode>;

const PluginsContext = createContext<ConversationCapabilities["plugins"]>([]);

/**
 * A plugin or Skill the prompt names, shown as itself and edited as one piece.
 * Its text is the token the prompt carries (`@Name` or `$name`), so the field's
 * text is the prompt as sent.
 */
class MentionNode extends DecoratorNode<ReactNode> {
  __mention: Mention;

  static getType(): string {
    return "prompt-mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mention, node.__key);
  }

  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return new MentionNode(serialized.mention);
  }

  constructor(mention: Mention, key?: NodeKey) {
    super(key);
    this.__mention = mention;
  }

  exportJSON(): SerializedMentionNode {
    return { ...super.exportJSON(), mention: this.__mention };
  }

  createDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = "prompt-mention-node";
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getTextContent(): string {
    return this.__mention.token;
  }

  isInline(): true {
    return true;
  }

  // The caret steps over a chip and Backspace removes it whole, without selecting it first.
  isKeyboardSelectable(): false {
    return false;
  }

  decorate(): ReactNode {
    return <MentionChip mention={this.__mention} />;
  }
}

function MentionChip({ mention }: { mention: Mention }) {
  const plugins = useContext(PluginsContext);
  return <span className="prompt-mention" data-mention={mention.kind} title={mention.token}>
    {mention.kind === "plugin"
      ? <PluginMentionGlyph mention={mention.mention} plugins={plugins} size={13} />
      : <WandSparkles size={13} aria-hidden="true" />}
    <span>{mention.kind === "plugin" ? mention.mention.displayName : skillDisplayName(mention.name)}</span>
  </span>;
}

/**
 * A plain-text prompt field that shows the plugins and Skills it names as
 * chips. Its value stays the prompt string; chips are how the field shows
 * tokens in it, so callers edit and send text as before.
 */
export function PromptEditor({ value, onChange, onSelectionChange, onKeyDown, mentions = [], plugins = [], skills = [], placeholder, disabled = false, readOnly = false, inputRef, className, aria }: {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (cursor: number) => void;
  /** Runs before the field handles a key; true when the key was used. */
  onKeyDown?: (event: KeyboardEvent, selection: PromptSelection) => boolean;
  /** Plugins the text mentions, shown as chips. */
  mentions?: readonly PluginMention[];
  /** The installed plugins, for the mentioned ones' icons. */
  plugins?: ConversationCapabilities["plugins"];
  /** The agent's Skills; `$name` of one is shown as a chip. */
  skills?: readonly string[];
  placeholder: string;
  disabled?: boolean;
  /** Keeps focus in the field while it cannot be edited, unlike `disabled`. */
  readOnly?: boolean;
  inputRef?: Ref<PromptInput>;
  className?: string;
  aria?: AriaAttributes;
}) {
  return (
    <LexicalComposer initialConfig={{
      namespace: "prompt",
      nodes: [MentionNode],
      editable: !disabled,
      onError: (error) => { throw error; },
      editorState: () => setText(value, tokenRanges(value, mentions, skills)),
    }}>
      <PluginsContext.Provider value={plugins}>
        <PlainTextPlugin
          contentEditable={<ContentEditable
            className={`prompt-editor nokey${className ? ` ${className}` : ""}`}
            aria-placeholder={placeholder}
            placeholder={<div className="prompt-editor-placeholder" aria-hidden="true">{placeholder}</div>}
            aria-disabled={disabled || undefined}
            aria-readonly={readOnly || undefined}
            aria-multiline
            role="textbox"
            spellCheck
            {...aria}
          />}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </PluginsContext.Provider>
      <HistoryPlugin />
      <PromptBridge value={value} onChange={onChange} onSelectionChange={onSelectionChange} onKeyDown={onKeyDown}
        mentions={mentions} skills={skills} disabled={disabled} readOnly={readOnly} inputRef={inputRef} />
    </LexicalComposer>
  );
}

/** Keeps the editor and the prompt text in step, both ways, and answers for the field. */
function PromptBridge({ value, onChange, onSelectionChange, onKeyDown, mentions, skills, disabled, readOnly, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (cursor: number) => void;
  onKeyDown?: (event: KeyboardEvent, selection: PromptSelection) => boolean;
  mentions: readonly PluginMention[];
  skills: readonly string[];
  disabled: boolean;
  readOnly: boolean;
  inputRef?: Ref<PromptInput>;
}) {
  const [editor] = useLexicalComposerContext();
  const latest = useRef({ onChange, onSelectionChange, onKeyDown, readOnly });
  latest.current = { onChange, onSelectionChange, onKeyDown, readOnly };
  // What the editor holds: its text and the chips in it, so a change from outside can be told apart.
  const shown = useRef({ text: value, chips: chipKey(tokenRanges(value, mentions, skills)) });

  useImperativeHandle(inputRef, () => ({
    focus(cursor) {
      editor.focus();
      if (cursor !== undefined) editor.update(() => selectOffset(cursor));
    },
    contains: (node) => Boolean(node && editor.getRootElement()?.contains(node)),
  }), [editor]);

  useEffect(() => editor.setEditable(!disabled), [editor, disabled]);

  // Show the text again when it changed outside, or when the plugins and Skills
  // known change which of its tokens are chips. Typing a token leaves it text,
  // so a name being typed never turns into a chip under the caret.
  const known = `${mentions.map((mention) => `${mention.marketplaceId}/${mention.name}/${mention.displayName}`).join("|")}\n${skills.join("|")}`;
  const shownKnown = useRef(known);
  useEffect(() => {
    if (editor.isComposing()) return;
    const ranges = tokenRanges(value, mentions, skills);
    const chips = chipKey(ranges);
    const knownChanged = shownKnown.current !== known;
    shownKnown.current = known;
    if (shown.current.text === value && (!knownChanged || shown.current.chips === chips)) return;
    const textChanged = shown.current.text !== value;
    shown.current = { text: value, chips };
    editor.update(() => {
      const selection = $getSelection();
      const cursor = $isRangeSelection(selection) ? Math.min(pointOffset(selection.focus), value.length) : undefined;
      setText(value, ranges);
      if (cursor !== undefined) selectOffset(cursor);
    }, { tag: textChanged ? "history-push" : "history-merge" });
  }, [editor, value, known]);

  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const text = textOf();
      const changed = text !== shown.current.text;
      shown.current = { text, chips: shownChips() };
      if (changed) latest.current.onChange(text);
      const selection = $getSelection();
      if ($isRangeSelection(selection)) latest.current.onSelectionChange?.(pointOffset(selection.focus));
    });
  }), [editor]);

  useEffect(() => editor.registerCommand(KEY_DOWN_COMMAND, (event) => {
    if (event.isComposing || event.keyCode === 229) return false;
    if (latest.current.readOnly) {
      if (!["Backspace", "Delete", "Enter", "Tab"].includes(event.key)) return false;
      event.preventDefault();
      return true;
    }
    const selection = editor.getEditorState().read(() => {
      const current = $getSelection();
      if (!$isRangeSelection(current)) return { start: 0, end: 0 };
      const [anchor, focus] = [pointOffset(current.anchor), pointOffset(current.focus)];
      return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
    });
    return latest.current.onKeyDown?.(event, selection) ?? false;
  }, COMMAND_PRIORITY_CRITICAL), [editor]);

  // A read-only field keeps focus, so keys stay out of the page's shortcuts, but takes no input.
  useEffect(() => editor.registerRootListener((root, previous) => {
    const block = (event: Event) => {
      if (!latest.current.readOnly) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ["beforeinput", "paste", "cut", "drop"] as const;
    for (const type of events) previous?.removeEventListener(type, block, true);
    for (const type of events) root?.addEventListener(type, block, true);
  }), [editor]);

  return null;
}

type TokenRange = { start: number; end: number; mention: Mention };

function tokenRanges(value: string, mentions: readonly PluginMention[], skills: readonly string[]): TokenRange[] {
  const ranges: TokenRange[] = [
    ...pluginMentionRanges(value, mentions).map(({ start, end, mention }): TokenRange => ({
      start, end, mention: { kind: "plugin", token: value.slice(start, end), mention },
    })),
    ...skillMentionRanges(value, skills).map(({ start, end, name }): TokenRange => ({
      start, end, mention: { kind: "skill", token: value.slice(start, end), name },
    })),
  ].sort((left, right) => left.start - right.start);
  return ranges.filter((range, index) => index === 0 || range.start >= ranges[index - 1]!.end);
}

function chipKey(ranges: readonly { start: number; mention: Mention }[]): string {
  return ranges.map((range) => `${range.start}:${range.mention.kind}:${range.mention.token}`).join("|");
}

/** The chips the editor shows, as `chipKey` writes them. */
function shownChips(): string {
  const chips: { start: number; mention: Mention }[] = [];
  let offset = 0;
  for (const [index, block] of $getRoot().getChildren().entries()) {
    if (index > 0) offset += 1;
    for (const child of $isElementNode(block) ? block.getChildren() : []) {
      if (child instanceof MentionNode) chips.push({ start: offset, mention: child.__mention });
      offset += child.getTextContentSize();
    }
  }
  return chipKey(chips);
}

/** Fills the editor with the text, its tokens as chips, in one paragraph with line breaks as plain text is. */
function setText(value: string, ranges: readonly TokenRange[]): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  const appendText = (text: string) => text.split("\n").forEach((line, index) => {
    if (index > 0) paragraph.append($createLineBreakNode());
    if (line) paragraph.append($createTextNode(line));
  });
  let end = 0;
  for (const range of ranges) {
    appendText(value.slice(end, range.start));
    paragraph.append(new MentionNode(range.mention));
    end = range.end;
  }
  appendText(value.slice(end));
  root.append(paragraph);
}

function textOf(): string {
  return $getRoot().getChildren().map((block) => block.getTextContent()).join("\n");
}

/** A point's position in the text, counting each chip as its token. */
function pointOffset(point: PointType): number {
  const node = point.getNode();
  let offset = point.type === "text" ? point.offset : 0;
  if (point.type === "element" && $isElementNode(node)) {
    const children = node.getChildren().slice(0, point.offset);
    offset += children.reduce((total, child) => total + child.getTextContentSize(), 0);
    // Blocks under the root are joined by a line break each.
    if (node === $getRoot()) offset += children.length;
  }
  for (let current: LexicalNode | null = node; current && current !== $getRoot(); current = current.getParent()) {
    const separator = current.getParent() === $getRoot() ? 1 : 0;
    for (let sibling = current.getPreviousSibling(); sibling; sibling = sibling.getPreviousSibling()) {
      offset += sibling.getTextContentSize() + separator;
    }
  }
  return offset;
}

/** Puts the caret at a position of the text; one inside a chip goes after it. */
function selectOffset(cursor: number): void {
  let remaining = Math.max(0, cursor);
  const blocks = $getRoot().getChildren();
  for (const [blockIndex, block] of blocks.entries()) {
    if (!$isElementNode(block)) continue;
    const size = block.getTextContentSize();
    if (remaining > size && blockIndex < blocks.length - 1) {
      remaining -= size + 1;
      continue;
    }
    const children = block.getChildren();
    for (const [index, child] of children.entries()) {
      const length = child.getTextContentSize();
      if ($isTextNode(child) && remaining <= length) {
        child.select(remaining, remaining);
        return;
      }
      if (remaining === 0) {
        block.select(index, index);
        return;
      }
      if (remaining < length) {
        block.select(index + 1, index + 1);
        return;
      }
      remaining -= length;
    }
    block.select(children.length, children.length);
    return;
  }
}
