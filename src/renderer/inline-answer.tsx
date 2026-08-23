import { ArrowRight, Pencil } from "lucide-react";
import type { KeyboardEvent } from "react";

interface InlineAnswerBaseProps {
  disabled?: boolean;
  label: string;
  placeholder?: string;
}

type InlineAnswerProps = InlineAnswerBaseProps & ({
  editing: false;
  onEdit: () => void;
} | {
  editing: true;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
});

export function InlineAnswer(props: InlineAnswerProps) {
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!props.editing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel?.();
      return;
    }
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (props.value.trim()) props.onSubmit();
  }

  if (!props.editing) {
    return (
      <button className="inline-answer" type="button" disabled={props.disabled} onClick={props.onEdit}>
        <span className="inline-answer-icon"><Pencil size={13} /></span>
        <span>{props.label}</span>
      </button>
    );
  }

  return (
    <div className="inline-answer inline-answer-editing">
      <span className="inline-answer-icon"><Pencil size={13} /></span>
      <input
        autoFocus
        className="inline-answer-input"
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={keyDown}
        placeholder={props.placeholder ?? "Type another answer"}
      />
      <button
        className="inline-answer-submit"
        type="button"
        disabled={props.disabled || !props.value.trim()}
        onClick={props.onSubmit}
        aria-label="Submit answer"
      >
        <ArrowRight size={15} />
      </button>
    </div>
  );
}
