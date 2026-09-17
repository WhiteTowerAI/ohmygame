import { useEffect, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { promptHistoryDirection } from "./prompt-history.js";

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
}: PromptBoxProps) {
  useEffect(() => {
    resizeTextarea(textareaRef?.current ?? null);
  }, [textareaRef, value]);

  function submit(event?: FormEvent): void {
    event?.preventDefault();
    onSubmit();
  }

  return (
    <form className={`prompt-box prompt-box-${variant}`} onSubmit={submit}>
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

function resizeTextarea(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
}
