import { useId, useRef } from "react";

export function PluginFilePicker({
  label,
  inputLabel,
  chooseLabel,
  emptyLabel,
  file,
  accept,
  disabled = false,
  onChange,
}: {
  label: string;
  inputLabel: string;
  chooseLabel: string;
  emptyLabel: string;
  file?: File;
  accept?: string;
  disabled?: boolean;
  onChange: (file?: File) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="plugin-file-picker">
      <span className="plugin-file-picker-label">{label}</span>
      <div className="plugin-file-picker-control">
        <button
          className="plugin-file-picker-button"
          type="button"
          disabled={disabled}
          aria-controls={inputId}
          onClick={() => input.current?.click()}
        >
          {chooseLabel}
        </button>
        <span
          className={`plugin-file-picker-name${file ? "" : " is-empty"}`}
          title={file?.name}
        >
          {file?.name ?? emptyLabel}
        </span>
      </div>
      <input
        id={inputId}
        ref={input}
        className="visually-hidden"
        type="file"
        accept={accept}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        aria-label={inputLabel}
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          onChange(selected);
        }}
      />
    </div>
  );
}
