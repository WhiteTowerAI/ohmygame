import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentModel, AgentModelCatalog, AgentModelRef } from "../shared/contracts.js";
import { listModels, waitForRuntime } from "./api.js";

interface ModelSelectorProps {
  models: AgentModel[];
  value?: AgentModelRef;
  disabled?: boolean;
  onChange: (model: AgentModel) => void;
}

export function ModelSelector({ models, value, disabled, onChange }: ModelSelectorProps) {
  if (models.length === 0) return null;
  const currentKey = value ? modelKey(value) : "";
  const currentAvailable = models.some((model) => modelKey(model) === currentKey);
  const providers = [...new Set(models.map((model) => model.provider))];

  return (
    <label className="model-selector" title="Model">
      <span className="visually-hidden">Model</span>
      <select
        aria-label="Model"
        disabled={disabled}
        value={currentAvailable ? currentKey : ""}
        onChange={(event) => {
          const model = models.find((candidate) => modelKey(candidate) === event.target.value);
          if (model) onChange(model);
        }}
      >
        <option value="" disabled>{value ? `${value.provider}/${value.id}` : "Default model"}</option>
        {providers.map((provider) => (
          <optgroup key={provider} label={provider}>
            {models.filter((model) => model.provider === provider).map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>{model.name}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronDown aria-hidden="true" size={12} />
    </label>
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
