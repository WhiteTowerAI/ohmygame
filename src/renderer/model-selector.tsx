import { Check, ChevronDown, ChevronLeft, ChevronRight } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentModel, AgentModelCatalog, AgentModelRef, AgentReasoningLevel } from "../shared/contracts.js";
import { listModels, MODELS_CHANGED_EVENT, waitForRuntime } from "./api.js";

interface ModelSelectorProps {
  models: AgentModel[];
  status?: AgentModelCatalogStatus;
  value?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  disabled?: boolean;
  onChange: (model: AgentModel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
}

export function ModelSelector({ models, status = "ready", value, reasoningLevel, disabled, onChange, onReasoningChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
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
      if (showReasoning) {
        setShowReasoning(false);
        return;
      }
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, showReasoning]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setShowReasoning(false);
    }
  }, [disabled]);

  const unavailableLabel = status === "loading" ? "Loading models..."
    : status === "error" ? "Could not load models"
    : "No language model";

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
        disabled={disabled || status !== "ready" || models.length === 0}
        onClick={() => {
          setOpen((value) => !value);
          setShowReasoning(false);
        }}
        title="Model"
      >
        <span className="model-selector-current">
          <span className="model-selector-name">{current?.name ?? unavailableLabel}</span>
          {current ? <small>{current.providerName}</small> : null}
        </span>
        <ChevronDown aria-hidden="true" size={12} />
      </button>

      {open ? (
        <div className="model-selector-popover" id={menuId}>
          {!showReasoning ? (
            <div className="model-selector-menu" role="menu" aria-label="Models">
              <div className="model-selector-model-list">
                {models.map((model) => {
                  const selected = modelKey(model) === currentKey;
                  return (
                    <button
                      className={selected ? "active" : ""}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      key={modelKey(model)}
                      onClick={() => {
                        if (!selected) onChange(model);
                        setOpen(false);
                        trigger.current?.focus();
                      }}
                      title={`${model.provider}/${model.id}`}
                    >
                      <span className="model-selector-name">{model.name}</span>
                      {selected ? <Check aria-hidden="true" size={12} /> : null}
                    </button>
                  );
                })}
              </div>
              {current ? (
                <button className="model-selector-reasoning" type="button" role="menuitem" onClick={() => setShowReasoning(true)}>
                  <span>Reasoning</span>
                  <span className="model-selector-setting-value">{reasoningLabel(reasoningLevel)}<ChevronRight size={12} /></span>
                </button>
              ) : null}
            </div>
          ) : null}

          {showReasoning ? (
            <div className="model-selector-submenu" role="menu" aria-label="Reasoning levels">
              <button className="model-selector-back" type="button" onClick={() => setShowReasoning(false)}>
                <ChevronLeft size={12} />
                <span>Reasoning</span>
              </button>
              {(current?.reasoningLevels ?? []).map((level) => {
                const selected = level === reasoningLevel;
                return (
                  <button
                    className={selected ? "active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    key={level}
                    onClick={() => {
                      if (!selected) onReasoningChange(level);
                      setOpen(false);
                      setShowReasoning(false);
                      trigger.current?.focus();
                    }}
                  >
                    <span>{reasoningLabel(level)}</span>
                    {selected ? <Check aria-hidden="true" size={12} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type AgentModelCatalogStatus = "loading" | "ready" | "error";
export type AgentModelCatalogState = AgentModelCatalog & { status: AgentModelCatalogStatus };

const EMPTY_CATALOG: AgentModelCatalogState = { models: [], defaultReasoningLevel: "medium", status: "loading" };
export function useAgentModels(): AgentModelCatalogState {
  const [catalog, setCatalog] = useState<AgentModelCatalogState>(EMPTY_CATALOG);
  useEffect(() => {
    let disposed = false;
    const load = () => {
      setCatalog((current) => ({ ...current, status: "loading" }));
      void waitForRuntime().then(listModels).then((available) => {
        if (!disposed) setCatalog({ ...available, status: "ready" });
      }).catch(() => {
        if (!disposed) setCatalog((current) => ({ ...current, models: [], defaultModel: undefined, status: "error" }));
      });
    };
    load();
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    return () => {
      disposed = true;
      window.removeEventListener(MODELS_CHANGED_EVENT, load);
    };
  }, []);
  return catalog;
}

function modelKey(model: AgentModelRef): string {
  return `${model.provider}\n${model.id}`;
}

function reasoningLabel(level?: AgentReasoningLevel): string {
  if (!level) return "Default";
  if (level === "xhigh") return "Extra high";
  return level[0].toUpperCase() + level.slice(1);
}
