import {
  STORY_FORMAT_PRESETS,
  type StoryFormatPresetId,
} from "../shared/story-formats.js";

export function StoryFormatOptions({
  value,
  disabled = false,
  onChange,
}: {
  value?: StoryFormatPresetId;
  disabled?: boolean;
  onChange: (value: StoryFormatPresetId) => void;
}) {
  return (
    <div
      className="story-format-options"
      role="radiogroup"
      aria-label="Canvas format"
    >
      {STORY_FORMAT_PRESETS.map((preset) => (
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
