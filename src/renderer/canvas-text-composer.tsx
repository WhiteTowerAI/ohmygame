import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { ModelSelector, type AgentModelCatalogStatus } from "./model-selector.js";
import { ArrowUp, LoaderCircle } from "./icons.js";

export interface CanvasTextModels {
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  defaultModel?: AgentModelRef;
  defaultReasoningLevel?: AgentReasoningLevel;
}

export function CanvasTextComposer({ models, modelStatus, defaultModel, defaultReasoningLevel = "medium", model, reasoningLevel, instruction, generating, busy, error, references, label = "Text generation instruction", placeholder = "Describe the text you want to generate", generateLabel = "Generate text", onInstruction, onModel, onReasoningChange, onGenerate }: CanvasTextModels & {
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  instruction: string;
  generating?: boolean;
  busy?: boolean;
  error?: string;
  references?: ReactNode;
  label?: string;
  placeholder?: string;
  generateLabel?: string;
  onInstruction(value: string): void;
  onModel(model: AgentModelRef, reasoningLevel: AgentReasoningLevel): void;
  onReasoningChange(level: AgentReasoningLevel): void;
  onGenerate(model: AgentModelRef, reasoningLevel: AgentReasoningLevel): void;
}) {
  const effectiveModel = model ?? defaultModel;
  const selectedModel = models.find((candidate) => candidate.provider === effectiveModel?.provider && candidate.id === effectiveModel.id);
  const effectiveReasoning = clampReasoningLevel(reasoningLevel ?? defaultReasoningLevel, selectedModel?.reasoningLevels ?? []);
  return <div className="story-text-composer nodrag nowheel">
    {references}
    <CanvasTextarea aria-label={label} rows={3} value={instruction} disabled={busy} placeholder={placeholder} onChange={onInstruction} />
    {error ? <p role="alert">{error}</p> : null}
    <div className="canvas-text-composer-actions">
      <ModelSelector variant="canvas" models={models} status={modelStatus} value={effectiveModel} reasoningLevel={reasoningLevel ?? defaultReasoningLevel} disabled={busy}
        onChange={(selected, level) => onModel({ provider: selected.provider, id: selected.id }, level)} onReasoningChange={onReasoningChange} />
      <button type="button" title={generateLabel} aria-label={generateLabel} disabled={busy || !instruction.trim() || !selectedModel} onClick={() => { if (selectedModel) onGenerate({ provider: selectedModel.provider, id: selectedModel.id }, effectiveReasoning); }}>
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
