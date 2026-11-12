import { useEffect, useRef, useState } from "react";
import type { PluginMediaKind, PluginMediaModelList } from "../shared/plugin-manifest.js";
import { getPluginMediaModels, listPluginMediaModels, setPluginMediaModelsShown } from "./api.js";
import { ChevronDown, LoaderCircle, RefreshCw, Search } from "./icons.js";
import { t } from "./i18n.js";

const TITLES: Record<PluginMediaKind, () => string> = {
  image: () => t("providers.imageModels"),
  video: () => t("providers.videoModels"),
  audio: () => t("providers.audioModels"),
  "3d": () => t("providers.model3DModels"),
};

/** Lists past this many get a search field. */
const SEARCH_FROM = 8;

/**
 * A plugin provider's media models of one kind. The ones that are on appear in
 * model pickers; a provider whose adapter lists the vendor's models can load
 * them here, and they stay off until turned on.
 */
export function PluginMediaModels({ providerId, providerName, kind }: { providerId: string; providerName: string; kind: PluginMediaKind }) {
  const [list, setList] = useState<PluginMediaModelList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // Where a model switched on or off stays listed until the page changes, so it does not jump away.
  const [placed, setPlaced] = useState<ReadonlyMap<string, boolean>>(new Map());
  const current = useRef(`${providerId}/${kind}`);
  current.current = `${providerId}/${kind}`;

  useEffect(() => {
    let active = true;
    setList(undefined);
    setError(undefined);
    setPlaced(new Map());
    setQuery("");
    void getPluginMediaModels(providerId, kind).then((loaded) => { if (active) setList(loaded); }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [providerId, kind]);

  async function run(operation: () => Promise<PluginMediaModelList>): Promise<void> {
    const key = current.current;
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await operation();
      if (current.current === key) setList(loaded);
    } catch (cause) {
      if (current.current === key) setError(errorMessage(cause));
    } finally {
      if (current.current === key) setBusy(false);
    }
  }

  function toggle(model: PluginMediaModelList["models"][number], shown: boolean): void {
    setPlaced((value) => value.has(model.id) ? value : new Map(value).set(model.id, model.shown));
    void run(() => setPluginMediaModelsShown(providerId, kind, [model.id], shown));
  }

  const search = query.trim().toLowerCase();
  const matches = (model: PluginMediaModelList["models"][number]) => !search || `${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase().includes(search);
  const listedAsShown = (model: PluginMediaModelList["models"][number]) => placed.get(model.id) ?? model.shown;
  const shownModels = list?.models.filter((model) => listedAsShown(model) && matches(model)) ?? [];
  const hiddenModels = list?.models.filter((model) => !listedAsShown(model) && matches(model)) ?? [];
  const shown = list?.models.filter((model) => model.shown).length ?? 0;
  const title = TITLES[kind]();

  return <section className="settings-detail-section provider-models" aria-label={title}>
    <div className="provider-models-heading">
      <h4>{title} <small>{list ? shown : ""}</small></h4>
      {list?.discoverable ? <div className="provider-models-heading-actions">
        <button className="settings-secondary-button" type="button" disabled={busy} onClick={() => { setHiddenOpen(true); void run(() => listPluginMediaModels(providerId, kind)); }} title={t("providers.mediaModels.loadTitle", { name: providerName })}>
          <RefreshCw size={13} className={busy ? "spin" : undefined} /><span>{list.listedAt ? t("models.refresh") : t("providers.mediaModels.load")}</span>
        </button>
      </div> : null}
    </div>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {list ? <>
      {list.discoverable && !list.listedAt ? <p className="settings-detail-hint">{t("providers.mediaModels.hint", { name: providerName })}</p> : null}
      {list.skipped ? <p className="settings-detail-hint">{t("providers.mediaModels.skipped", { count: list.skipped })}</p> : null}
      {list.models.length > SEARCH_FROM ? <div className="provider-models-controls">
        <label className="settings-provider-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("models.search")} aria-label={t("models.search")} /></label>
      </div> : null}
      <div className="provider-models-list" role="list" aria-label={title} aria-busy={busy}>
        {[...shownModels, ...(hiddenOpen ? hiddenModels : [])].map((model) => {
          const description = model.description ? `${model.id} · ${model.description}` : model.name !== model.id ? model.id : undefined;
          return <div className={`provider-model-row${model.shown ? "" : " is-hidden"}${description === model.id ? " is-compact" : ""}`} key={model.id} role="listitem">
            <label>
              <input type="checkbox" checked={model.shown} disabled={busy} onChange={(event) => toggle(model, event.target.checked)} aria-label={t("plugins.enableName", { name: model.name })} />
              <span className="provider-model-copy"><strong title={model.name}>{model.name}</strong>{description ? <small title={description}>{description}</small> : null}</span>
            </label>
          </div>;
        })}
        {!shownModels.length && !(hiddenOpen && hiddenModels.length) ? <p className="settings-empty">{search ? t("models.empty.noMatch") : t("models.empty.noneShown")}</p> : null}
      </div>
      {hiddenModels.length ? <button className="provider-models-hidden-toggle" type="button" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((open) => !open)}>
        {t("models.hiddenCount", { count: hiddenModels.length })}<ChevronDown size={12} aria-hidden="true" />
      </button> : null}
    </> : !error ? <div className="settings-loading-row"><LoaderCircle className="spin" size={16} />{t("providers.loadingModels")}</div> : null}
  </section>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
