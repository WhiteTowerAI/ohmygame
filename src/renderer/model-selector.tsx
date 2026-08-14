import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentModel, AgentModelCatalog, AgentModelRef } from "../shared/contracts.js";
import { listModels, waitForRuntime } from "./api.js";

interface ModelSelectorProps {
  models: AgentModel[];
  value?: AgentModelRef;
  disabled?: boolean;
  onChange: (model: AgentModel) => void;
}

export function ModelSelector({ models, value, disabled, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const currentKey = value ? modelKey(value) : "";
  const current = models.find((model) => modelKey(model) === currentKey);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (models.length === 0) return null;

  return (
    <div className="model-selector" ref={root}>
      <button
        ref={trigger}
        className="model-selector-trigger"
        type="button"
        aria-label="Model"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title="Model"
      >
        <span>{current?.name ?? (value ? value.id : "Default model")}</span>
        <ChevronDown aria-hidden="true" size={12} />
      </button>

      {open ? (
        <div className="model-selector-menu" id={menuId} role="menu" aria-label="Models">
          {models.map((model) => {
            const selected = modelKey(model) === currentKey;
            return (
              <button
                className="model-selector-option"
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={modelKey(model)}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange(model);
                  trigger.current?.focus();
                }}
                title={`${model.provider}/${model.id}`}
              >
                {model.name}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_CATALOG: AgentModelCatalog = { models: [] };

export function useAgentModels(): AgentModelCatalog {
  const [catalog, setCatalog] = useState<AgentModelCatalog>(EMPTY_CATALOG);
  useEffect(() => {
    let disposed = false;
    void waitForRuntime().then(listModels).then((available) => {
      if (!disposed) setCatalog(available);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  return catalog;
}

function modelKey(model: AgentModelRef): string {
  return `${model.provider}\n${model.id}`;
}
