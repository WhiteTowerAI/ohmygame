import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { clipboardFiles, hasTransferredFiles, pasteNativeFiles, transferredFiles, type TransferredFile } from "./file-transfer.js";
import { promptHistoryDirection } from "./prompt-history.js";
import { editPromptList, promptListLines } from "./prompt-lists.js";

export type DroppedFile = TransferredFile;

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
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  overlay?: ReactNode;
  content?: ReactNode;
  prefix?: ReactNode;
  leading?: ReactNode;
  actions: ReactNode;
  onCommandKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
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
  textareaRef,
  overlay,
  content,
  prefix,
  leading,
  actions,
  onCommandKeyDown,
  onSelectionChange,
  onDropFiles,
  onDropError,
}: PromptBoxProps) {
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const localTextarea = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? localTextarea;
  const listMirror = useRef<HTMLDivElement>(null);
  const pendingCursor = useRef<number | undefined>(undefined);
  const lines = variant === "project" ? promptListLines(value) : [];
  const showListMirror = lines.some(({ list }) => list && /^[-+*]$/.test(list.marker));
  useLayoutEffect(() => {
    const input = inputRef.current;
    resizeTextarea(input);
    if (input && pendingCursor.current !== undefined) {
      input.setSelectionRange(pendingCursor.current, pendingCursor.current);
      onSelectionChange?.(pendingCursor.current);
      pendingCursor.current = undefined;
    }
    syncListMirror();
  }, [value, showListMirror]);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const observer = new ResizeObserver(syncListMirror);
    observer.observe(input);
    return () => observer.disconnect();
  }, [inputRef]);

  function syncListMirror(): void {
    const input = inputRef.current;
    const mirror = listMirror.current;
    if (!input || !mirror) return;
    mirror.style.width = `${input.clientWidth}px`;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    onSubmit();
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
      {dropActive ? <div className="prompt-box-drop-overlay">Drop files to attach</div> : null}
      {overlay}
      {content}
      <div className="prompt-box-input">
        {prefix}
        <div className={`prompt-box-editor${showListMirror ? " has-list-mirror" : ""}`}>
        {showListMirror ? <div className="prompt-box-list-mirror" aria-hidden="true" ref={listMirror}>
          {lines.map(({ text, list }, index) => <span key={index}>
            {list && /^[-+*]$/.test(list.marker) ? <>{list.indent}<span className="prompt-box-list-bullet">{list.marker}</span>{list.spacing}{list.task}{list.content}</> : text}
            {index < lines.length - 1 ? "\n" : ""}
          </span>)}
          {value.endsWith("\n") ? " " : null}
        </div> : null}
        <textarea
          ref={inputRef}
          aria-label="Prompt"
          disabled={disabled}
          readOnly={readOnly}
          onChange={(event) => {
            onChange(event.target.value);
            onSelectionChange?.(event.currentTarget.selectionStart);
          }}
          onSelect={(event) => onSelectionChange?.(event.currentTarget.selectionStart)}
          onInput={(event) => resizeTextarea(event.currentTarget)}
          onScroll={syncListMirror}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (readOnly || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (onCommandKeyDown?.(event)) return;
            if (variant === "project" && !event.metaKey && !event.ctrlKey && !event.altKey) {
              const edit = editPromptList(value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.key, event.shiftKey);
              if (edit) {
                event.preventDefault();
                if (edit.value !== value) {
                  pendingCursor.current = edit.cursor;
                  onChange(edit.value);
                }
                return;
              }
            }
            const historyDirection = promptHistoryDirection(
              event.key,
              event.currentTarget.selectionStart,
              event.currentTarget.selectionEnd,
              value.length,
            );
            if (historyDirection === "previous" && onHistoryPrevious) {
              event.preventDefault();
              onHistoryPrevious();
              return;
            }
            if (historyDirection === "next" && onHistoryNext) {
              event.preventDefault();
              onHistoryNext();
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={1}
          value={value}
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

function resizeTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight + 1, 132)}px`;
}
