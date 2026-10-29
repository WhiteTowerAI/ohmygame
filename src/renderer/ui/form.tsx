import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { Check, ChevronDown, Search, X } from "../icons.js";
import { t } from "../i18n.js";
import { Popover } from "./overlay.js";
import "./form.css";

/** A label, the control, and an optional hint or error under it. */
export function Field({
  label,
  hint,
  error,
  children,
  inline = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  inline?: boolean;
  children: (props: {
    id: string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  return (
    <div className={`ui-field${inline ? " ui-field-inline" : ""}`}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      <div className="ui-field-control">
        {children({
          id,
          "aria-describedby": hint || error ? noteId : undefined,
          "aria-invalid": error ? true : undefined,
        })}
        {error ? (
          <p id={noteId} className="ui-field-error">
            {error}
          </p>
        ) : hint ? (
          <p id={noteId} className="ui-field-hint">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size" | "prefix"
> {
  size?: "sm" | "md";
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export function Input({
  size = "md",
  prefix,
  suffix,
  className = "",
  ...props
}: InputProps) {
  return (
    <span className={`ui-input ui-input-${size} ${className}`}>
      {prefix ? <span className="ui-input-affix">{prefix}</span> : null}
      <input {...props} />
      {suffix ? <span className="ui-input-affix">{suffix}</span> : null}
    </span>
  );
}

/** A search box with a clear button once it has text. */
export function SearchInput({
  value,
  onChange,
  placeholder = t("ui.search"),
  size = "md",
  label = t("ui.search"),
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md";
  label?: string;
  id?: string;
}) {
  return (
    <Input
      id={id}
      size={size}
      type="search"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && value) {
          event.stopPropagation();
          onChange("");
        }
      }}
      prefix={<Search size={14} />}
      suffix={
        value ? (
          <button
            type="button"
            className="ui-input-clear"
            aria-label={t("common.clear")}
            onClick={() => onChange("")}
          >
            <X size={12} />
          </button>
        ) : null
      }
    />
  );
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`ui-textarea ${className}`} {...props} />;
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
  indeterminate = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <label className={`ui-check${disabled ? " is-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        ref={(node) => {
          if (node) node.indeterminate = indeterminate;
        }}
      />
      <span className="ui-check-box" aria-hidden="true">
        {indeterminate ? (
          <span className="ui-check-dash" />
        ) : checked ? (
          <Check size={12} />
        ) : null}
      </span>
      <span className="ui-check-text">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly {
    value: T;
    label: ReactNode;
    description?: ReactNode;
    disabled?: boolean;
  }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <div className="ui-radio-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label
          key={option.value}
          className={`ui-check ui-radio${option.disabled ? " is-disabled" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="ui-check-box" aria-hidden="true" />
          <span className="ui-check-text">
            <span>{option.label}</span>
            {option.description ? <small>{option.description}</small> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`ui-switch ui-switch-${size}${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  format = String,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
}) {
  const percent = ((value - min) / (max - min)) * 100;
  return (
    <span className="ui-slider">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--ui-slider-fill": `${percent}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output className="ui-slider-value">{format(value)}</output>
    </span>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

function OptionList<T extends string>({
  options,
  value,
  onPick,
  active,
  setActive,
}: {
  options: readonly SelectOption<T>[];
  value?: T;
  onPick: (value: T) => void;
  active: number;
  setActive: (index: number) => void;
}) {
  if (!options.length)
    return <p className="ui-listbox-empty">{t("ui.noMatchingOptions")}</p>;
  return (
    <div className="ui-listbox" role="listbox">
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="option"
          aria-selected={option.value === value}
          disabled={option.disabled}
          className={`ui-option${index === active ? " is-active" : ""}`}
          onPointerEnter={() => setActive(index)}
          onClick={() => onPick(option.value)}
        >
          {option.icon ? (
            <span className="ui-option-icon">{option.icon}</span>
          ) : null}
          <span className="ui-option-text">
            <span>{option.label}</span>
            {option.description ? <small>{option.description}</small> : null}
          </span>
          {option.value === value ? (
            <Check size={14} className="ui-option-check" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function useListKeys(
  options: readonly { disabled?: boolean }[],
  onEnter: (index: number) => void,
) {
  const [active, setActive] = useState(-1);
  // The next enabled option in that direction, or `from` when there is none.
  const step = (from: number, direction: 1 | -1) => {
    for (let index = from + direction; index >= 0 && index < options.length; index += direction)
      if (!options[index]?.disabled) return index;
    return from;
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    // Enter while an input method is composing confirms the text, not an option.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => step(index, 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index < 0 ? step(-1, 1) : step(index, -1)));
    }
    if (event.key === "Enter" && active >= 0 && !options[active]?.disabled) {
      event.preventDefault();
      onEnter(active);
    }
  };
  return { active, setActive, onKeyDown };
}

/** A button that opens a list of options. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = t("ui.selectPlaceholder"),
  size = "md",
  id,
}: {
  value?: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  label: string;
  placeholder?: string;
  size?: "sm" | "md";
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pick = (next: T) => {
    onChange(next);
    setOpen(false);
    anchor.current?.focus();
  };
  const keys = useListKeys(options, (index) => pick(options[index]!.value));
  const current = options.find((option) => option.value === value);
  return (
    <>
      <button
        ref={anchor}
        id={id}
        type="button"
        className={`ui-select ui-select-${size}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((state) => !state)}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "Enter")) {
            event.preventDefault();
            setOpen(true);
          } else if (open) keys.onKeyDown(event);
        }}
      >
        {current?.icon ? (
          <span className="ui-option-icon">{current.icon}</span>
        ) : null}
        <span className={current ? "ui-select-value" : "ui-select-placeholder"}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="ui-select-caret" />
      </button>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        matchWidth
        label={label}
      >
        <OptionList
          options={options}
          value={value}
          onPick={pick}
          active={keys.active}
          setActive={keys.setActive}
        />
      </Popover>
    </>
  );
}

/** A text box that filters a list of options as you type. */
export function Combobox<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = t("ui.searchPlaceholder"),
  size = "md",
}: {
  value?: T;
  options: readonly (SelectOption<T> & { keywords?: string })[];
  onChange: (value: T) => void;
  label: string;
  placeholder?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? options.filter((option) =>
          `${String(option.label)} ${option.value} ${option.keywords ?? ""}`
            .toLowerCase()
            .includes(needle),
        )
      : options;
  }, [options, query]);
  const pick = (next: T) => {
    onChange(next);
    close();
  };
  const keys = useListKeys(filtered, (index) => pick(filtered[index]!.value));
  const current = options.find((option) => option.value === value);
  return (
    <>
      <span ref={anchor} className={`ui-input ui-input-${size} ui-combobox`}>
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-autocomplete="list"
          value={
            open
              ? query
              : typeof current?.label === "string"
                ? current.label
                : (value ?? "")
          }
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            keys.setActive(0);
          }}
          onKeyDown={keys.onKeyDown}
        />
        <ChevronDown size={14} className="ui-select-caret" />
      </span>
      <Popover
        open={open}
        onClose={close}
        anchor={anchor}
        matchWidth
        label={label}
      >
        <OptionList
          options={filtered}
          value={value}
          onPick={pick}
          active={keys.active}
          setActive={keys.setActive}
        />
      </Popover>
    </>
  );
}

/** Toggleable filter pills; `multiple` allows several at once. */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: ReactNode; count?: number }[];
  value: readonly T[];
  onChange: (value: T[]) => void;
}) {
  return (
    <div className="ui-filter-chips" role="group" aria-label={label}>
      {options.map((option) => {
        const on = value.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            className={`ui-filter-chip${on ? " is-on" : ""}`}
            onClick={() =>
              onChange(
                on
                  ? value.filter((item) => item !== option.value)
                  : [...value, option.value],
              )
            }
          >
            {option.label}
            {option.count !== undefined ? (
              <span className="ui-filter-count">{option.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
