import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StoryVariable, StoryVariableType, StoryVariableValue } from "../shared/contracts.js";
import { Plus, Trash2, X } from "./icons.js";

export function StoryVariablesDialog({ variables, usageCounts, onClose, onApply }: {
  variables: StoryVariable[];
  usageCounts: Readonly<Record<string, number>>;
  onClose: () => void;
  onApply: (variables: StoryVariable[]) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(() => structuredClone(variables));
  const normalized = useMemo(() => draft.map((variable) => ({ ...variable, name: variable.name.trim() })), [draft]);
  const names = normalized.map((variable) => variable.name);
  const valid = names.every(Boolean) && new Set(names).size === names.length;
  const changed = JSON.stringify(draft) !== JSON.stringify(variables);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  function addVariable(): void {
    const used = new Set(draft.map((variable) => variable.name));
    let index = draft.length + 1;
    while (used.has(`variable${index}`)) index += 1;
    setDraft((current) => [...current, { id: crypto.randomUUID(), name: `variable${index}`, type: "text", initialValue: "" }]);
  }

  function removeVariable(variable: StoryVariable): void {
    const uses = usageCounts[variable.id] ?? 0;
    const detail = uses ? ` This will also remove ${uses} structured ${uses === 1 ? "reference" : "references"}.` : "";
    if (!window.confirm(`Delete variable "${variable.name || "Unnamed variable"}"?${detail} Custom code is not updated automatically.`)) return;
    setDraft((current) => current.filter((candidate) => candidate.id !== variable.id));
  }

  return <div className="project-create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="project-create-dialog story-variables-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header>
        <div><h2 id={titleId}>Variables</h2><p>Initial values are used when a new game starts.</p></div>
        <button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="story-variables-content">
        <div className="story-variable-headings" aria-hidden="true"><span>Name</span><span>Type</span><span>Initial value</span><span /></div>
        {draft.map((variable) => <div className="story-state-variable" key={variable.id}>
          <input aria-label={`${variable.name || "Variable"} name`} value={variable.name} placeholder="Variable name" onChange={(event) => setDraft((current) => current.map((candidate) => candidate.id === variable.id ? { ...candidate, name: event.target.value } : candidate))} />
          <select aria-label={`${variable.name || "Variable"} type`} value={variable.type} onChange={(event) => {
            const type = event.target.value as StoryVariableType;
            setDraft((current) => current.map((candidate) => candidate.id === variable.id ? { ...candidate, type, initialValue: defaultVariableValue(type) } : candidate));
          }}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option></select>
          <VariableValueInput variable={variable} value={variable.initialValue} onChange={(initialValue) => setDraft((current) => current.map((candidate) => candidate.id === variable.id ? { ...candidate, initialValue } : candidate))} />
          <button type="button" title="Delete variable" aria-label={`Delete ${variable.name || "variable"}`} onClick={() => removeVariable(variable)}><Trash2 size={13} /></button>
        </div>)}
        {!draft.length ? <p className="story-variables-empty">No variables defined</p> : null}
        <button className="story-field-add" type="button" onClick={addVariable}><Plus size={14} />Add variable</button>
        {!valid ? <p className="story-variables-error" role="alert">Variable names must be non-empty and unique.</p> : null}
        <p className="story-variables-note">Renaming keeps structured references intact. Custom code references are not updated automatically.</p>
      </div>
      <footer>
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="project-create-submit" type="button" disabled={!changed || !valid} onClick={() => { onApply(normalized); onClose(); }}>Apply</button>
      </footer>
    </section>
  </div>;
}

function VariableValueInput({ variable, value, onChange }: { variable: StoryVariable; value: StoryVariableValue; onChange: (value: StoryVariableValue) => void }) {
  if (variable.type === "boolean") return <select aria-label={`${variable.name || "Variable"} initial value`} value={value === true ? "true" : "false"} onChange={(event) => onChange(event.target.value === "true")}><option value="false">False</option><option value="true">True</option></select>;
  return <input aria-label={`${variable.name || "Variable"} initial value`} type={variable.type === "number" ? "number" : "text"} value={String(value)} onChange={(event) => onChange(variable.type === "number" ? Number(event.target.value) : event.target.value)} />;
}

function defaultVariableValue(type: StoryVariableType): StoryVariableValue {
  return type === "boolean" ? false : type === "number" ? 0 : "";
}
