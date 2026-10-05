import { useLayoutEffect, useRef, useState } from "react";

interface SegmentedControlProps<Value extends string> {
  className: string;
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}

export function SegmentedControl<Value extends string>({ className, label, options, value, onChange }: SegmentedControlProps<Value>) {
  const control = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number }>();

  useLayoutEffect(() => {
    const element = control.current;
    if (!element) return;
    const measure = (): void => {
      const selected = element.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
      if (!selected) {
        setIndicator(undefined);
        return;
      }
      const left = selected.offsetLeft;
      const width = selected.offsetWidth;
      setIndicator((current) => current?.left === left && current.width === width ? current : { left, width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("button").forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value, options]);

  return (
    <div className={`segmented-control ${className}`} role="group" aria-label={label} ref={control}>
      {indicator ? <span className="segmented-control-indicator" aria-hidden="true" style={{ width: indicator.width, transform: `translateX(${indicator.left}px)` }} /> : null}
      {options.map((option) => (
        <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}
