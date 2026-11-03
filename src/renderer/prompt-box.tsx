import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { clipboardFiles, hasTransferredFiles, pasteNativeFiles, transferredFiles, type TransferredFile } from "./file-transfer.js";
import { promptHistoryDirection } from "./prompt-history.js";
import { editPromptList } from "./prompt-lists.js";
import { PromptEditor, type PromptInput, type PromptSelection } from "./prompt-editor.js";
import { sendsMessage } from "./general-preferences.js";
import { t } from "./i18n.js";

export type DroppedFile = TransferredFile;
export type { PromptInput, PromptSelection };

interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onHistoryPrevious?: () => void;
  onHistoryNext?: () => void;
  disabled?: boolean;
  /** Keeps focus in the field while it cannot be edited, unlike `disabled`. */
  readOnly?: boolean;
  placeholder: string;
  variant: "home" | "project";
  inputRef?: RefObject<PromptInput | null>;
  /** Plugins the prompt mentions, shown as chips in it. */
  mentions?: readonly PluginMention[];
  /** The installed plugins, for the mentioned ones' icons. */
  plugins?: ConversationCapabilities["plugins"];
  /** The agent's Skills; `$name` of one is shown as a chip. */
  skills?: readonly string[];
  overlay?: ReactNode;
  suggestions?: { id: string; activeId?: string };
  content?: ReactNode;
  leading?: ReactNode;
  actions: ReactNode;
  onCommandKeyDown?: (event: KeyboardEvent, selection: PromptSelection) => boolean;
  onSelectionChange?: (cursor: number) => void;
  onDropFiles?: (files: DroppedFile[]) => void;
  onDropError?: (error: Error) => void;
}

export function PromptBox({
  value,
  onChange,
  onSubmit,
  onHistoryPrevious,
  onHistoryNext,
  disabled,
  readOnly,
  placeholder,
  variant,
  inputRef,
  mentions,
  plugins,
  skills,
  overlay,
  suggestions,
  content,
  leading,
  actions,
  onCommandKeyDown,
  onSelectionChange,
  onDropFiles,
  onDropError,
}: PromptBoxProps) {
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const localInput = useRef<PromptInput>(null);
  const input = inputRef ?? localInput;
  const pendingCursor = useRef<number | undefined>(undefined);
  // A list edit replaces the text; its caret lands once the field shows it.
  useEffect(() => {
    if (pendingCursor.current === undefined) return;
    input.current?.focus(pendingCursor.current);
    pendingCursor.current = undefined;
  }, [value]);

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent, selection: PromptSelection): boolean {
    if (onCommandKeyDown?.(event, selection)) return true;
    if (variant === "project" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const edit = editPromptList(value, selection.start, selection.end, event.key, event.shiftKey);
      if (edit) {
        event.preventDefault();
        if (edit.value !== value) {
          pendingCursor.current = edit.cursor;
          onChange(edit.value);
        }
        return true;
      }
    }
    const historyDirection = promptHistoryDirection(event.key, selection.start, selection.end, value.length);
    if (historyDirection === "previous" && onHistoryPrevious) {
      event.preventDefault();
      onHistoryPrevious();
      return true;
    }
    if (historyDirection === "next" && onHistoryNext) {
      event.preventDefault();
      onHistoryNext();
      return true;
    }
    if (sendsMessage(event)) {
      event.preventDefault();
      submit();
      return true;
    }
    return false;
  }

  return (
    <form
      className={`prompt-box prompt-box-${variant}${dropActive ? " prompt-box-drop-active" : ""}`}
      onSubmit={submit}
      onKeyDown={(event) => { if (onDropFiles && !disabled) pasteNativeFiles(event, onDropFiles, onDropError); }}
      onDragEnter={(event) => {
        if (!onDropFiles || disabled || !hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!onDropFiles || disabled || !hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!onDropFiles || disabled || !hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!onDropFiles || disabled || !hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        const dataTransfer = event.dataTransfer;
        void transferredFiles(dataTransfer).then((files) => {
          if (files.length) onDropFiles(files);
        }).catch((cause) => onDropError?.(cause instanceof Error ? cause : new Error(String(cause))));
      }}
      onPaste={(event) => {
        if (!onDropFiles || disabled) return;
        const files = clipboardFiles(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        onDropFiles(files.map((file) => ({ file })));
      }}
    >
      {dropActive ? <div className="prompt-box-drop-overlay">{t("composer.drop")}</div> : null}
      {overlay}
      {content}
      <div className="prompt-box-input">
        <div className="prompt-box-editor">
          <PromptEditor
            value={value}
            onChange={onChange}
            onSelectionChange={onSelectionChange}
            onKeyDown={handleKeyDown}
            mentions={mentions}
            plugins={plugins}
            skills={skills}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            inputRef={input}
            aria={{
              "aria-label": t("composer.prompt"),
              "aria-controls": suggestions?.id,
              "aria-activedescendant": suggestions?.activeId,
              "aria-autocomplete": suggestions ? "list" : undefined,
            }}
          />
        </div>
      </div>
      <div className="prompt-box-toolbar">
        <div className="prompt-box-leading">{leading}</div>
        <div className="prompt-box-actions">{actions}</div>
      </div>
    </form>
  );
}
