import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { promptHistoryDirection } from "./prompt-history.js";

export interface DroppedFile {
  file: File;
  relativePath?: string;
}

interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onHistoryPrevious?: () => void;
  onHistoryNext?: () => void;
  disabled?: boolean;
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
  useEffect(() => {
    resizeTextarea(textareaRef?.current ?? null);
  }, [textareaRef, value]);

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    onSubmit();
  }

  return (
    <form
      className={`prompt-box prompt-box-${variant}${dropActive ? " prompt-box-drop-active" : ""}`}
      onSubmit={submit}
      onDragEnter={(event) => {
        if (!onDropFiles || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDropActive(true);
      }}
      onDragOver={(event) => {
        if (!onDropFiles || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!onDropFiles || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropActive(false);
      }}
      onDrop={(event) => {
        if (!onDropFiles || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropActive(false);
        const dataTransfer = event.dataTransfer;
        void droppedFiles(dataTransfer).then((files) => {
          if (files.length) onDropFiles(files);
        }).catch((cause) => onDropError?.(cause instanceof Error ? cause : new Error(String(cause))));
      }}
    >
      {dropActive ? <div className="prompt-box-drop-overlay">Drop files to attach</div> : null}
      {overlay}
      {content}
      <div className="prompt-box-input">
        {prefix}
        <textarea
          ref={textareaRef}
          aria-label="Prompt"
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            onSelectionChange?.(event.currentTarget.selectionStart);
          }}
          onSelect={(event) => onSelectionChange?.(event.currentTarget.selectionStart)}
          onInput={(event) => resizeTextarea(event.currentTarget)}
          onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (onCommandKeyDown?.(event)) return;
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
      <div className="prompt-box-toolbar">
        <div className="prompt-box-leading">{leading}</div>
        <div className="prompt-box-actions">{actions}</div>
      </div>
    </form>
  );
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return event.dataTransfer.types.includes("Files");
}

async function droppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const entries = [...dataTransfer.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file }));
  return (await Promise.all(entries.map((entry) => filesFromEntry(entry)))).flat();
}

function filesFromEntry(entry: FileSystemEntry, prefix = ""): Promise<DroppedFile[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        (file) => resolve([{ file, relativePath: `${prefix}${file.name}` }]),
        () => reject(new Error(`Could not read ${prefix}${entry.name}`)),
      );
    });
  }
  if (!entry.isDirectory) return Promise.resolve([]);
  const directory = entry as FileSystemDirectoryEntry;
  return readDirectoryEntries(directory.createReader()).then(async (children) => (
    (await Promise.all(children.map((child) => filesFromEntry(child, `${prefix}${entry.name}/`)))).flat()
  ));
}

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(entries);
      entries.push(...batch);
      next();
    }, reject);
    next();
  });
}

function resizeTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
}
