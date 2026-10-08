import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Settings } from "./icons.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentModel, AgentModelCatalog, AgentModelRef, AgentReasoningLevel } from "../shared/contracts.js";
import { clampReasoningLevel, reasoningLabel } from "../shared/reasoning.js";
import { listModels, MODELS_CHANGED_EVENT, waitForRuntime } from "./api.js";
import { menuPlacement } from "./popover-placement.js";
import { settingsHash } from "./routes.js";

interface ModelSelectorProps {
  models: AgentModel[];
  status?: AgentModelCatalogStatus;
  value?: AgentModelRef | AgentModel;
  reasoningLevel?: AgentReasoningLevel;
  disabled?: boolean;
  variant?: "chat" | "canvas";
  placement?: "above" | "below";
  onChange: (model: AgentModel, reasoningLevel: AgentReasoningLevel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
}

type ModelPanel = { view: "models" | "reasoning"; anchor: "model" | "reasoning" };

export function ModelSelector({ models, status = "ready", value, reasoningLevel, disabled, variant = "chat", placement = "above", onChange, onReasoningChange }: ModelSelectorProps) {
  const [panel, setPanel] = useState<ModelPanel>();
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reasoningTrigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const currentKey = value ? modelKey(value) : "";
  const current = models.find((model) => modelKey(model) === currentKey) ?? (value && "name" in value ? value : undefined);
  const visibleModels = status === "ready" ? filterModels(models, query) : [];
  const providerGroups = groupModelsByProvider(visibleModels);
  const effectiveReasoning = clampReasoningLevel(reasoningLevel ?? "medium", current?.reasoningLevels ?? []);
  const supportsReasoning = !!current && current.reasoningLevels.length > 1;
  const open = !!panel;
  const showReasoning = panel?.view === "reasoning";
  const canvas = variant === "canvas";
  const canSelect = status === "ready" && models.length > 0;

  function close(restoreFocus = false): void {
    setPanel(undefined);
    if (restoreFocus) (panel?.anchor === "reasoning" ? reasoningTrigger : trigger).current?.focus();
  }

  function toggle(anchor: ModelPanel["anchor"]): void {
    if (panel?.anchor === anchor) { close(); return; }
    setQuery("");
    setPosition(undefined);
    setPanel({ anchor, view: anchor === "reasoning" ? "reasoning" : "models" });
  }

  function select(model: AgentModel): void {
    if (modelKey(model) !== currentKey) onChange(model, clampReasoningLevel(reasoningLevel ?? "medium", model.reasoningLevels));
    close();
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!panel) return;
    const anchor = (panel.anchor === "reasoning" ? reasoningTrigger : trigger).current?.getBoundingClientRect();
    const bounds = popover.current?.getBoundingClientRect();
    if (anchor && bounds) setPosition(menuPlacement(anchor, bounds, { width: window.innerWidth, height: window.innerHeight }, canvas ? "start" : "end", placement));
    // Query changes keep the popup anchored in place while its list shrinks.
  }, [panel?.view, panel?.anchor, canvas, placement]);

  useEffect(() => {
    if (!open || !position) return;
    if (showReasoning) {
      const selected = popover.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? popover.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]');
      selected?.focus();
    }
    else search.current?.focus();
  }, [open, showReasoning, position]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPanel(undefined);
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) close();
    };
    const onMove = (event: Event) => {
      if (!popover.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("wheel", onMove, { capture: true, passive: true });
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("wheel", onMove, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    setPanel(undefined);
  }, [disabled, status]);

  useEffect(() => {
    if (!supportsReasoning) setPanel((current) => current?.view === "reasoning" ? undefined : current);
  }, [supportsReasoning]);

  const unavailableLabel = status === "loading" ? "Loading models..."
    : status === "error" ? "Could not load models"
    : "No language model";

  return (
    <div className={`model-selector${canvas ? " model-selector-canvas" : ""}`} ref={root}>
      <button
        ref={trigger}
        className={canvas ? "canvas-chip is-wide" : "model-selector-trigger"}
        type="button"
        aria-label={canvas ? `Text model: ${current?.name ?? unavailableLabel}` : "Model"}
        aria-controls={menuId}
        aria-expanded={open && panel.anchor === "model"}
        aria-haspopup="menu"
        disabled={disabled || (!canvas && !canSelect)}
        onClick={() => toggle("model")}
        title={canvas && current ? `Text model: ${current.providerName} · ${current.name}` : "Model"}
      >
        {canvas ? <span>{current?.name ?? unavailableLabel}</span> : <span className="model-selector-current">
          <span className="model-selector-name">{current?.name ?? unavailableLabel}</span>
          {current ? <small>{current.providerName}</small> : null}
        </span>}
        <ChevronDown aria-hidden="true" size={12} />
      </button>

      {canvas && supportsReasoning ? <button ref={reasoningTrigger} type="button" className="canvas-chip" aria-label={`Reasoning: ${reasoningLabel(effectiveReasoning)}`}
        title={`Reasoning: ${reasoningLabel(effectiveReasoning)}`} aria-controls={menuId} aria-haspopup="menu" aria-expanded={open && panel.anchor === "reasoning"}
        disabled={disabled || !canSelect} onClick={() => toggle("reasoning")}>
        <span>{reasoningLabel(effectiveReasoning)}</span><ChevronDown aria-hidden="true" size={12} />
      </button> : null}

      {panel ? createPortal(
        <div className={`model-selector-popover nodrag nowheel${canvas ? " model-selector-popover-canvas" : ""}`} ref={popover} id={menuId} style={position ?? { top: 0, left: 0, visibility: "hidden" }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" || (showReasoning && event.key === "ArrowLeft")) {
            event.preventDefault();
            event.stopPropagation();
            if (showReasoning && (panel.anchor === "model" || event.key === "ArrowLeft")) setPanel({ ...panel, view: "models" });
            else close(true);
          } else moveModelFocus(event, popover.current, showReasoning ? undefined : search.current);
        }}>
          {!showReasoning ? (
            <div className="model-selector-menu" role="menu" aria-label="Models">
              <label className="model-selector-search">
                <Search size={13} aria-hidden="true" />
                <input ref={search} value={query} placeholder="Search models" aria-label="Search models" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const first = visibleModels[0];
                  if (!first) return;
                  select(first);
                }} />
              </label>
              <div className="model-selector-model-list">
                {providerGroups.map((group) => (
                  <div className="model-selector-provider-group" role="group" aria-label={group.providerName} key={group.provider}>
                    <div className="model-selector-provider-name">{group.providerName}</div>
                    {group.models.map((model) => {
                      const selected = modelKey(model) === currentKey;
                      return (
                        <button
                          className={selected ? "active" : ""}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          key={modelKey(model)}
                          onClick={() => select(model)}
                          title={`${model.provider}/${model.id}`}
                        >
                          <span className="model-selector-name">{model.name}</span>
                          {selected ? <Check aria-hidden="true" size={12} /> : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {visibleModels.length === 0 ? <p className="model-selector-empty" role="status">{status !== "ready" || !query.trim() ? unavailableLabel : "No matching models"}</p> : null}
              </div>
              {supportsReasoning && canSelect ? (
                <button className="model-selector-reasoning" type="button" role="menuitem" onClick={() => setPanel({ ...panel, view: "reasoning" })}>
                  <span>Reasoning</span>
                  <span className="model-selector-setting-value">{reasoningLabel(effectiveReasoning)}<ChevronRight size={12} /></span>
                </button>
              ) : null}
              <button className="model-selector-manage" type="button" role="menuitem" onClick={() => {
                close(true);
                window.location.hash = settingsHash("providers");
              }}><Settings aria-hidden="true" size={13} /><span>Manage providers</span></button>
            </div>
          ) : null}

          {showReasoning ? (
            <div className="model-selector-submenu" role="menu" aria-label="Reasoning levels">
              <button className="model-selector-back" type="button" role="menuitem" onClick={() => setPanel({ ...panel, view: "models" })}>
                <ChevronLeft size={12} />
                <span>Reasoning</span>
              </button>
              {(current?.reasoningLevels ?? []).map((level) => {
                const selected = level === effectiveReasoning;
                return (
                  <button
                    className={selected ? "active" : ""}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    key={level}
                    onClick={() => {
                      if (!selected) onReasoningChange(level);
                      close(true);
                    }}
                  >
                    <span>{reasoningLabel(level)}</span>
                    {selected ? <Check aria-hidden="true" size={12} /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>,
        document.body,
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
    let generation = 0;
    const load = () => {
      const request = ++generation;
      setCatalog((current) => ({ ...current, status: "loading" }));
      void waitForRuntime().then(listModels).then((available) => {
        if (!disposed && request === generation) setCatalog({ ...available, status: "ready" });
      }).catch(() => {
        if (!disposed && request === generation) setCatalog((current) => ({ ...current, models: [], hiddenModels: undefined, defaultModel: undefined, status: "error" }));
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

export function filterModels(models: AgentModel[], query: string): AgentModel[] {
  const search = query.trim().toLowerCase();
  return search ? models.filter((model) => `${model.name} ${model.id} ${model.provider} ${model.providerName}`.toLowerCase().includes(search)) : models;
}

function moveModelFocus(event: React.KeyboardEvent, menu: HTMLDivElement | null, search?: HTMLInputElement | null): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  event.stopPropagation();
  const items = [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowUp" && index === 0 && search) {
    search.focus();
    return;
  }
  const next = index < 0 ? event.key === "ArrowDown" ? 0 : items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export function groupModelsByProvider(models: AgentModel[]): { provider: string; providerName: string; models: AgentModel[] }[] {
  const groups = new Map<string, { provider: string; providerName: string; models: AgentModel[] }>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.models.push(model);
    else groups.set(model.provider, { provider: model.provider, providerName: model.providerName, models: [model] });
  }
  return [...groups.values()];
}
