import { Check, ChevronDown, ChevronRight } from "./icons.js";
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
  const [submenu, setSubmenu] = useState<"model" | "reasoning">();
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
      if (submenu) {
        setSubmenu(undefined);
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
  }, [open, submenu]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setSubmenu(undefined);
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
        disabled={disabled || status !== "ready" || !current}
        onClick={() => {
          setOpen((value) => !value);
          setSubmenu(undefined);
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
          <div className="model-selector-menu" role="menu" aria-label="Agent settings">
            <button className={submenu === "model" ? "active" : ""} type="button" role="menuitem" onClick={() => setSubmenu("model")}>
              <span>Model</span>
              <span className="model-selector-setting-value">{current?.name ?? "Default"}<ChevronRight size={14} /></span>
            </button>
            <button className={submenu === "reasoning" ? "active" : ""} type="button" role="menuitem" onClick={() => setSubmenu("reasoning")}>
              <span>Reasoning</span>
              <span className="model-selector-setting-value">{reasoningLabel(reasoningLevel)}<ChevronRight size={14} /></span>
            </button>
          </div>

          {submenu === "model" ? (
            <div className="model-selector-submenu" role="menu" aria-label="Models">
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
                      setSubmenu(undefined);
                      trigger.current?.focus();
                    }}
                    title={`${model.provider}/${model.id}`}
                  >
                    <span className="model-selector-model-copy">
                      <span className="model-selector-name">{model.name}</span>
                      <small>{model.providerName}</small>
                    </span>
                    {selected ? <Check aria-hidden="true" size={13} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {submenu === "reasoning" ? (
            <div className="model-selector-submenu" role="menu" aria-label="Reasoning levels">
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
                      setSubmenu(undefined);
                      trigger.current?.focus();
                    }}
                  >
                    <span>{reasoningLabel(level)}</span>
                    {selected ? <Check aria-hidden="true" size={13} /> : null}
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
