import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { AgentModel, AgentModelRef } from "../shared/contracts.js";
import type { AgentModelCatalogStatus } from "./model-selector.js";
import { CanvasChipSelect } from "./canvas-chip-select.js";
import { ArrowUp, LoaderCircle } from "./icons.js";
import { settingsHash } from "./routes.js";

export interface CanvasTextModels {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
}

export function CanvasTextComposer({ models, modelStatus, defaultModel, model, instruction, generating, busy, error, label = "Text generation instruction", placeholder = "Describe the text you want to generate", generateLabel = "Generate text", onInstruction, onModel, onGenerate }: CanvasTextModels & {
  model?: AgentModelRef;
  instruction: string;
  generating?: boolean;
  busy?: boolean;
  error?: string;
  label?: string;
  placeholder?: string;
  generateLabel?: string;
  onInstruction(value: string): void;
  onModel(model: AgentModelRef): void;
  onGenerate(model: AgentModelRef): void;
}) {
  const effectiveModel = model ?? defaultModel;
  const selectedModel = models.find((candidate) => candidate.provider === effectiveModel?.provider && candidate.id === effectiveModel.id);
  const modelKey = (value: AgentModelRef) => `${value.provider}\n${value.id}`;
  const modelStateLabel = modelStatus === "loading" ? "Loading models..." : modelStatus === "error" ? "Could not load models" : "No language model";
  return <div className="story-text-composer nodrag nowheel">
    <CanvasTextarea aria-label={label} rows={3} value={instruction} disabled={busy} placeholder={placeholder} onChange={onInstruction} />
    {error ? <p role="alert">{error}</p> : null}
    <div>
      <CanvasChipSelect label="Text model" wide value={selectedModel ? modelKey(selectedModel) : undefined} placeholder={modelStateLabel}
        options={models.map((candidate) => ({ value: modelKey(candidate), label: candidate.name, group: candidate.providerName }))}
        action={{ label: "Manage providers", onSelect: () => { window.location.hash = settingsHash("providers"); } }} disabled={busy}
        onChange={(key) => { const selected = models.find((candidate) => modelKey(candidate) === key); if (selected) onModel({ provider: selected.provider, id: selected.id }); }} />
      <button type="button" title={generateLabel} aria-label={generateLabel} disabled={busy || !instruction.trim() || !selectedModel} onClick={() => { if (selectedModel) onGenerate({ provider: selectedModel.provider, id: selectedModel.id }); }}>
        {generating ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={18} />}
      </button>
    </div>
  </div>;
}

function useCanvasTextDraft(value: string, onChange: (value: string) => void, disabled?: boolean) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const composing = useRef(false);
  const latest = useRef(value);
  useEffect(() => {
    if (disabled) editing.current = false;
    if (!editing.current && !composing.current) { latest.current = value; setDraft(value); }
  }, [value, disabled]);
  const change = (text: string, isComposing = false) => {
    latest.current = text; setDraft(text);
    if (!composing.current && !isComposing) onChange(text);
  };
  return {
    value: draft,
    onFocus: () => { editing.current = true; },
    onBlur: () => {
      editing.current = false;
      if (composing.current) { composing.current = false; onChange(latest.current); }
    },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(event.currentTarget.value, (event.nativeEvent as InputEvent).isComposing),
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: (event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      composing.current = false;
      change(event.currentTarget.value);
    },
  };
}

type CanvasTextProps<T> = Omit<T, "value" | "onChange" | "onFocus" | "onBlur" | "onCompositionStart" | "onCompositionEnd"> & {
  value: string;
  onChange: (value: string) => void;
};
// React Flow propagates node data one render late. Publish an IME draft only after composition ends.
export function CanvasTextarea({ value, onChange, ...props }: CanvasTextProps<TextareaHTMLAttributes<HTMLTextAreaElement>>) {
  const draft = useCanvasTextDraft(value, onChange, props.disabled);
  return <textarea {...props} {...draft} />;
}
export function CanvasTextInput({ value, onChange, ...props }: CanvasTextProps<InputHTMLAttributes<HTMLInputElement>>) {
  const draft = useCanvasTextDraft(value, onChange, props.disabled);
  return <input {...props} {...draft} />;
}
