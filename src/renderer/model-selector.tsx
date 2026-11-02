import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, Settings } from "./icons.js";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AGENT_REASONING_LEVELS, type AgentModel, type AgentModelCatalog, type AgentModelRef, type AgentReasoningLevel } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { isAgentRuntimeId, nativeEffort, type AccountProfileIds } from "../shared/agent-runtimes.js";
import { reasoningLabel } from "./reasoning-label.js";
import { t } from "./i18n.js";
import { listModels, MODELS_CHANGED_EVENT, waitForRuntime } from "./api.js";
import { menuPlacement } from "./popover-placement.js";
import { settingsHash } from "./routes.js";
import { PROVIDER_ICONS } from "./provider-icons.js";
import "./model-selector.css";

interface ModelSelectorProps {
  models: AgentModel[];
  status?: AgentModelCatalogStatus;
  value?: AgentModelRef | AgentModel;
  reasoningLevel?: AgentReasoningLevel;
  nativeReasoningLevel?: string;
  disabled?: boolean;
  variant?: "chat" | "canvas";
  placement?: "above" | "below";
  onChange: (model: AgentModel, reasoningLevel: AgentReasoningLevel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
  onNativeReasoningChange?: (level: string) => void;
}

export function ModelSelector({ models, status = "ready", value, reasoningLevel, nativeReasoningLevel, disabled, variant = "chat", placement = "above", onChange, onReasoningChange, onNativeReasoningChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  // The depth opens in place of the models, so the list keeps its room and a rarely changed setting stays one row.
  const [depthOpen, setDepthOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const depthEntry = useRef<HTMLButtonElement>(null);
  const returningToModels = useRef(false);
  const menuId = useId();
  const currentKey = value ? modelKey(value) : "";
  const current = models.find((model) => modelKey(model) === currentKey) ?? (value && "name" in value ? value : undefined);
  const visibleModels = status === "ready" ? filterModels(models, query) : [];
  const providerGroups = groupModelsByProvider(visibleModels);
  const effectiveReasoning = clampReasoningLevel(reasoningLevel ?? "medium", current?.reasoningLevels ?? []);
  const native = isAgentRuntimeId(current?.provider) && variant !== "canvas";
  const levels = native ? current?.nativeReasoningLevels ?? [] : current?.reasoningLevels ?? [];
  const effectiveLevel = native ? nativeEffort(current, nativeReasoningLevel) : effectiveReasoning;
  const label = (level: string | undefined) => level && (AGENT_REASONING_LEVELS as readonly string[]).includes(level) ? reasoningLabel(level as AgentReasoningLevel) : level ?? "";
  const reasoningText = label(effectiveLevel);
  const supportsReasoning = levels.length > 1;
  const positioned = position !== undefined;
  const canvas = variant === "canvas";
  const canSelect = status === "ready" && models.length > 0;

  function close(restoreFocus = false): void {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  function toggle(): void {
    if (open) { close(); return; }
    setQuery("");
    setDepthOpen(false);
    setPosition(undefined);
    setOpen(true);
  }

  function select(model: AgentModel): void {
    if (modelKey(model) !== currentKey) onChange(model, clampReasoningLevel(reasoningLevel ?? "medium", model.reasoningLevels));
    close(true);
  }

  function selectLevel(level: string): void {
    if (level !== effectiveLevel) {
      if (native) onNativeReasoningChange?.(level);
      else onReasoningChange(level as AgentReasoningLevel);
    }
    close(true);
  }

  function backToModels(): void {
    returningToModels.current = true;
    setDepthOpen(false);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = popover.current?.getBoundingClientRect();
    if (anchor && bounds) setPosition(menuPlacement(anchor, bounds, { width: window.innerWidth, height: window.innerHeight }, canvas ? "start" : "end", placement));
    // Query changes keep the popup anchored in place while its list shrinks.
  }, [open, canvas, placement]);

  useEffect(() => {
    if (!open || !positioned) return;
    if (depthOpen) popover.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
    else (returningToModels.current ? depthEntry : search).current?.focus();
    returningToModels.current = false;
  }, [open, positioned, depthOpen]);

  useEffect(() => {
    if (!supportsReasoning) setDepthOpen(false);
  }, [supportsReasoning]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
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
    setOpen(false);
  }, [disabled, status]);

  const unavailableLabel = status === "loading" ? t("modelSelector.loading")
    : status === "error" ? t("modelSelector.error")
    : t("modelSelector.none");

  return (
    <div className={`model-selector${canvas ? " model-selector-canvas" : ""}`} ref={root}>
      <button
        ref={trigger}
        className={canvas ? "canvas-chip" : "model-selector-trigger"}
        type="button"
        aria-label={canvas ? t("modelSelector.textModel", { name: current?.name ?? unavailableLabel }) : t("modelSelector.model")}
        aria-description={supportsReasoning ? t("modelSelector.reasoning", { level: reasoningText }) : undefined}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled || (!canvas && !canSelect)}
        onClick={toggle}
        title={current ? `${t("modelSelector.textModelTitle", { provider: current.providerName, name: current.name })}${supportsReasoning ? ` · ${reasoningText}` : ""}` : unavailableLabel}
      >
        {current ? <ProviderMark provider={current.provider} name={current.providerName} /> : null}
        <span className="model-selector-name">{current?.name ?? unavailableLabel}</span>
        {supportsReasoning ? <span className="model-selector-reasoning-value">{reasoningText}</span> : null}
        <ChevronDown className="model-selector-caret" aria-hidden="true" size={canvas ? 12 : 14} />
      </button>

      {open ? createPortal(
        <div className={`model-picker nodrag nowheel${canvas ? " is-canvas" : ""}`} ref={popover} id={menuId} data-native-preview-overlay style={position ?? { top: 0, left: 0, visibility: "hidden" }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" || (depthOpen && event.key === "ArrowLeft")) {
            event.preventDefault();
            event.stopPropagation();
            if (depthOpen) backToModels();
            else close(true);
          } else moveModelFocus(event, popover.current, depthOpen ? undefined : search.current);
        }}>
          {depthOpen ? (
            <div className="model-picker-list" role="menu" aria-label={t("modelSelector.depth")}>
              <button className="model-picker-back" type="button" role="menuitem" aria-label={t("modelSelector.backToModels")} onClick={backToModels}>
                <ChevronLeft aria-hidden="true" size={12} />
                {t("modelSelector.depth")}
              </button>
              <div className="ui-menu-separator" role="separator" />
              {levels.map((level) => {
                const selected = level === effectiveLevel;
                return (
                  <button className="model-picker-item" type="button" role="menuitemradio" aria-checked={selected} key={level} onClick={() => selectLevel(level)}>
                    <span className="model-picker-item-name">{label(level)}</span>
                    {selected ? <Check className="model-picker-check" aria-hidden="true" size={14} /> : null}
                  </button>
                );
              })}
            </div>
          ) : (<>
          <div className="model-picker-search">
            <Search size={14} aria-hidden="true" />
            <input ref={search} value={query} placeholder={t("models.search")} aria-label={t("models.search")} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              event.stopPropagation();
              const first = visibleModels[0];
              if (first) select(first);
            }} />
            <button className="model-picker-manage" type="button" aria-label={t("modelSelector.manage")} title={t("modelSelector.manage")} onClick={() => {
              close(true);
              window.location.hash = settingsHash(native ? "agents" : "providers");
            }}><Settings aria-hidden="true" size={14} /></button>
          </div>
          <div className="ui-menu-separator" role="separator" />
          <div className="model-picker-list" role="menu" aria-label={t("models.title")}>
            {providerGroups.map((group) => (
              <div className="model-picker-group" role="group" aria-label={group.providerName} key={group.provider}>
                <div className="model-picker-heading"><ProviderMark provider={group.provider} name={group.providerName} size={12} />{group.providerName}</div>
                {group.models.map((model) => {
                  const selected = modelKey(model) === currentKey;
                  return (
                    <button
                      className="model-picker-item"
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      key={modelKey(model)}
                      onClick={() => select(model)}
                      title={`${model.provider}/${model.id}`}
                    >
                      <span className="model-picker-item-name">{model.name}</span>
                      {selected ? <Check className="model-picker-check" aria-hidden="true" size={14} /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {visibleModels.length === 0 ? <p className="model-picker-empty" role="status">{status !== "ready" || !query.trim() ? unavailableLabel : t("modelSelector.noMatch")}</p> : null}
          </div>
          {/* Only a model whose thinking can be set shows the depth. */}
          {canSelect && supportsReasoning ? (<>
            <div className="ui-menu-separator" role="separator" />
            <button ref={depthEntry} className="model-picker-depth" type="button" role="menuitem" aria-haspopup="menu" onClick={() => setDepthOpen(true)} onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setDepthOpen(true);
            }}>
              <span>{t("modelSelector.depth")}</span>
              <span className="model-picker-depth-value">{reasoningText}<ChevronRight aria-hidden="true" size={12} /></span>
            </button>
          </>) : null}
          </>)}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

export type AgentModelCatalogStatus = "loading" | "ready" | "error";
export type AgentModelCatalogState = AgentModelCatalog & { status: AgentModelCatalogStatus };

const EMPTY_CATALOG: AgentModelCatalogState = { models: [], defaultReasoningLevel: "medium", status: "loading" };
/** The models a picker offers. Conversations pass `agentRuntimes` to list coding agents' models with OhMyGame's own. */
export function useAgentModels(options: { agentRuntimes?: boolean; accountProfiles?: AccountProfileIds } = {}): AgentModelCatalogState {
  const [catalog, setCatalog] = useState<AgentModelCatalogState>(EMPTY_CATALOG);
  const agentRuntimes = options.agentRuntimes === true;
  const profileKey = JSON.stringify(options.accountProfiles);
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let retries = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (quiet = false) => {
      clearTimeout(retry);
      const request = ++generation;
      if (!quiet) setCatalog((current) => ({ ...current, status: "loading" }));
      void waitForRuntime().then(() => listModels({ agentRuntimes, accountProfiles: profileKey ? JSON.parse(profileKey) as AccountProfileIds : undefined })).then((available) => {
        if (disposed || request !== generation) return;
        setCatalog({ ...available, status: "ready" });
        // Poll pending CLI discovery and Pi refreshes without hiding the existing models.
        if ((available.loadingRuntimes?.length || available.loadingProviders?.length) && retries < 6) {
          retries++;
          retry = setTimeout(() => load(true), 3_000);
        }
      }).catch(() => {
        if (!disposed && request === generation) setCatalog((current) => ({ ...current, models: [], hiddenModels: undefined, defaultModel: undefined, status: "error" }));
      });
    };
    const reload = () => { retries = 0; load(); };
    reload();
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => {
      disposed = true;
      clearTimeout(retry);
      window.removeEventListener(MODELS_CHANGED_EVENT, reload);
    };
  }, [agentRuntimes, profileKey]);
  return catalog;
}

/** A provider's logo, or its initial when it has none (custom providers). */
export function ProviderMark({ provider, name, size = 14 }: { provider?: string; name?: string; size?: number }) {
  const icon = provider ? PROVIDER_ICONS[provider] : undefined;
  if (icon) return <img className={`provider-mark is-${icon.tone}`} src={icon.src} width={size} height={size} alt="" aria-hidden="true" />;
  const initial = (name ?? provider ?? "").trim().charAt(0).toUpperCase();
  return initial ? <span className="provider-mark is-initial" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }} aria-hidden="true">{initial}</span> : null;
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
  const items = [...(menu?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]') ?? [])];
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
