import { useEffect, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";

interface PromptBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder: string;
  variant: "home" | "project";
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  content?: ReactNode;
  leading?: ReactNode;
  actions: ReactNode;
}

export function PromptBox({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  variant,
  textareaRef,
  content,
  leading,
  actions,
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
      {content}
      <textarea
        ref={textareaRef}
        aria-label="Prompt"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onInput={(event) => resizeTextarea(event.currentTarget)}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        rows={1}
        value={value}
      />
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
