import {
  CANVAS_FORMAT_PRESETS,
  type CanvasFormatPresetId,
} from "../shared/canvas-formats.js";

export function CanvasFormatOptions({
  value,
  disabled = false,
  onChange,
}: {
  value?: CanvasFormatPresetId;
  disabled?: boolean;
  onChange: (value: CanvasFormatPresetId) => void;
}) {
  return (
    <div
      className="story-format-options"
      role="radiogroup"
      aria-label="Canvas format"
    >
      {CANVAS_FORMAT_PRESETS.map((preset) => (
        <button
          className={preset.id === value ? "is-active" : undefined}
          type="button"
          role="radio"
          aria-checked={preset.id === value}
          disabled={disabled}
          key={preset.id}
          onClick={() => onChange(preset.id)}
        >
          <span
            className={`story-format-frame story-format-frame-${preset.id}`}
            aria-hidden="true"
          />
          <span>
            <strong>{preset.label}</strong>
            <small>{preset.ratio}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
