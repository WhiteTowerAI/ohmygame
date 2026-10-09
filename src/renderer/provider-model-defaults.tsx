import { useEffect, useState } from "react";
import type { MediaModelCatalog, ModelRef, ProviderCapability } from "../shared/contracts.js";
import { MODEL_USAGE_LABELS } from "../shared/custom-models.js";
import { listImageModelCatalog, listModel3DCatalog, listVideoModelCatalog, MODELS_CHANGED_EVENT, setDefaultMediaModel } from "./api.js";

type MediaUsage = Exclude<ProviderCapability, "language">;
type Catalog = MediaModelCatalog<ModelRef & { name: string; providerName: string }>;
export function ProviderModelDefaults({ providerId }: { providerId: string }) {
  const [catalogs, setCatalogs] = useState<Partial<Record<MediaUsage, Catalog>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void Promise.allSettled([listImageModelCatalog(), listVideoModelCatalog(), listModel3DCatalog()]).then((results) => {
        if (!active || current !== revision) return;
        const loaded: Partial<Record<MediaUsage, Catalog>> = {};
        let failure: string | undefined;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") loaded[(["image", "video", "3d"] as const)[index]] = result.value;
          else failure ??= result.reason instanceof Error ? result.reason.message : String(result.reason);
        });
        setCatalogs(loaded);
        setError(failure);
      });
    };
    refresh();
    window.addEventListener(MODELS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(MODELS_CHANGED_EVENT, refresh); };
  }, [providerId]);
  async function choose(usage: MediaUsage, key: string) {
    const model = catalogs[usage]?.models.find((model) => modelKey(model) === key);
    if ((key && !model) || busy) return;
    setBusy(true); setError(undefined);
    try {
      const selected = model ? { provider: model.provider, id: model.id } : undefined;
      await setDefaultMediaModel(usage, selected);
      setCatalogs((current) => ({ ...current, [usage]: { ...current[usage]!, defaultModel: selected } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const available = (["image", "video", "3d"] as const).filter((usage) => catalogs[usage]?.models.some((model) => model.provider === providerId) || catalogs[usage]?.defaultModel?.provider === providerId);
  if (!available.length && !error) return null;
  return <section className="settings-detail-section custom-provider-defaults" aria-label="Default generation models">
    <h4>Default generation models</h4>
    <p className="settings-detail-hint">Choose the defaults for new generations. Existing canvas nodes keep their selected models.</p>
    {error ? <p role="alert" className="settings-error">{error}</p> : null}
    {available.map((usage) => {
      const catalog = catalogs[usage]!;
      const current = catalog.defaultModel;
      const configured = current && catalog.models.some((model) => modelKey(model) === modelKey(current));
      return <label className="settings-detail-field" key={usage}><span className="settings-search-field-label">{MODEL_USAGE_LABELS[usage]}</span>
        <select className="settings-search-input" aria-label={`Default ${MODEL_USAGE_LABELS[usage]} model`} disabled={busy}
          value={configured ? modelKey(current) : current ? "__unavailable" : ""} onChange={(event) => void choose(usage, event.target.value)}>
          <option value="">Automatic</option>
          {current && !configured ? <option value="__unavailable" disabled>Selected model unavailable — choose a model</option> : null}
          {catalog.models.map((model) => <option key={modelKey(model)} value={modelKey(model)}>{model.providerName} · {model.name}</option>)}
        </select>
      </label>;
    })}
  </section>;
}
function modelKey(model: ModelRef): string { return JSON.stringify([model.provider, model.id]); }
