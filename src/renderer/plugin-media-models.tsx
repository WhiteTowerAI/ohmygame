import { useEffect, useRef, useState } from "react";
import type { PluginMediaKind, PluginMediaModelList } from "../shared/plugin-manifest.js";
import { getPluginMediaModels, listPluginMediaModels, setPluginMediaModelsShown, savePluginModel3D, removePluginModel3D } from "./api.js";
import { ChevronDown, LoaderCircle, RefreshCw, Search, Pencil, Plus, Trash2, X } from "./icons.js";
import { t } from "./i18n.js";
import { PluginModel3DForm } from "./plugin-model3d-form.js";

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
  return <Models key={`${providerId}/${kind}`} providerId={providerId} providerName={providerName} kind={kind} />;
}

function Models({ providerId, providerName, kind }: { providerId: string; providerName: string; kind: PluginMediaKind }) {
  const [list, setList] = useState<PluginMediaModelList>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // Where a model switched on or off stays listed until the page changes, so it does not jump away.
  const [placed, setPlaced] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Freeze the edit revision so another settings window cannot silently overwrite this draft.
  const [editing, setEditing] = useState<{ editor: NonNullable<PluginMediaModelList["editor"]>; initial?: PluginMediaModelList["models"][number] }>();
  const [deleting, setDeleting] = useState<string>();
  const active = useRef(false);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const mutation = useRef(false);
  const restoreFocus = useRef(false);
  const addButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!editing && !busy && restoreFocus.current) {
      restoreFocus.current = false;
      (editButton.current?.isConnected ? editButton.current : addButton.current)?.focus();
    }
  }, [editing, busy]);

  useEffect(() => {
    active.current = true;
    let pending = true;
    setList(undefined);
    setError(undefined);
    setPlaced(new Map());
    setQuery("");
    void getPluginMediaModels(providerId, kind).then((loaded) => { if (pending && active.current) setList(loaded); }).catch((cause) => { if (pending && active.current) setError(errorMessage(cause)); });
    return () => { pending = false; active.current = false; };
  }, [providerId, kind]);

  async function run(operation: () => Promise<PluginMediaModelList>): Promise<boolean> {
    if (mutation.current) return false;
    mutation.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const loaded = await operation();
      if (!active.current) return false;
      setList(loaded);
      return true;
    } catch (cause) {
      if (active.current) setError(errorMessage(cause));
      return false;
    } finally {
      mutation.current = false;
      if (active.current) setBusy(false);
    }
  }

  function finishEdit() {
    setEditing(undefined);
    restoreFocus.current = true;
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
      {list && (list.discoverable || list.editor?.templates.length) ? <div className="provider-models-heading-actions">
        {list.editor?.templates.length ? <button ref={addButton} className="settings-secondary-button" type="button" disabled={busy || Boolean(editing)} onClick={event => { editButton.current = event.currentTarget; setEditing({ editor: list.editor! }); setDeleting(undefined); setError(undefined); }}><Plus size={13} /><span>{t("common.add")}</span></button> : null}
        {list.discoverable ? <button className="settings-secondary-button" type="button" disabled={busy || Boolean(editing)} onClick={() => { setHiddenOpen(true); void run(() => listPluginMediaModels(providerId, kind)); }} title={t("providers.mediaModels.loadTitle", { name: providerName })}>
          <RefreshCw size={13} className={busy ? "spin" : undefined} /><span>{list.listedAt ? t("models.refresh") : t("providers.mediaModels.load")}</span>
        </button> : null}
      </div> : null}
    </div>
    {error && !editing ? <><p className="settings-error" role="alert">{error}</p>{!editing ? <button className="settings-secondary-button" type="button" disabled={busy} onClick={() => { void run(() => getPluginMediaModels(providerId, kind)); }}>{t("models.refresh")}</button> : null}</> : null}
    {editing ? <PluginModel3DForm editor={editing.editor} initial={editing.initial} busy={busy} saveError={error} onSave={request => { void run(() => savePluginModel3D(providerId, request)).then(saved => { if (saved) finishEdit(); }); }} onCancel={() => { finishEdit(); void run(() => getPluginMediaModels(providerId, kind)); }} onReset={editing.initial?.default && !editing.initial.custom && editing.initial.edited ? () => { void run(() => removePluginModel3D(providerId, editing.initial!.id, editing.editor.revision, true)).then(saved => { if (saved) finishEdit(); }); } : undefined} /> : null}
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
              <input type="checkbox" checked={model.shown} disabled={busy || Boolean(editing)} onChange={(event) => toggle(model, event.target.checked)} aria-label={t("plugins.enableName", { name: model.name })} />
              <span className="provider-model-copy"><strong title={model.name}>{model.name}</strong>{description ? <small title={description}>{description}</small> : null}</span>
            </label>
            {list.editor && model.definition && (model.default || model.shown || model.edited) ? <button className="icon-button" type="button" disabled={busy || Boolean(editing)} title={t("common.editName", { name: model.name })} aria-label={t("common.editName", { name: model.name })} onClick={event => { editButton.current = event.currentTarget; setEditing({ editor: list.editor!, initial: model }); setDeleting(undefined); setError(undefined); }}><Pencil size={14} /></button> : null}
            {list.editor && (model.custom || model.edited && !model.default) ? deleting === model.id ? <div className="provider-model-delete-confirm">
              <button type="button" className="settings-danger-button" disabled={busy || Boolean(editing)} onClick={() => { void run(() => removePluginModel3D(providerId, model.id, list.editor!.revision)).then(saved => { if (saved) { setDeleting(undefined); editButton.current = null; restoreFocus.current = true; } }); }}>{t("common.delete")}</button>
              <button type="button" className="icon-button" disabled={busy} title={t("models.cancelDeletion")} aria-label={t("models.cancelDeletion")} onClick={() => setDeleting(undefined)}><X size={13} /></button>
            </div> : <button className="icon-button provider-model-delete" type="button" disabled={busy || Boolean(editing)} title={t("common.deleteName", { name: model.name })} aria-label={t("common.deleteName", { name: model.name })} onClick={() => setDeleting(model.id)}><Trash2 size={14} /></button> : null}
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
