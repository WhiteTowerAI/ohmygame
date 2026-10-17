import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  OpenAIImageConnectionSettings,
  OpenAIImageModelConfiguration,
  SaveOpenAIImageConnectionRequest,
} from "../shared/contracts.js";
import {
  discoverOpenAIImageModels,
  getOpenAIImageSettings,
  removeOpenAIImageSettings,
  saveOpenAIImageSettings,
} from "./api.js";
import {
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "./icons.js";
import { t } from "./i18n.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const templateName = (template: OpenAIImageModelConfiguration["template"]) =>
  template === "gpt-image-1"
    ? t("openAIImages.fixedSizes")
    : t("openAIImages.flexibleSizes");

export function OpenAIImageModels({
  revision,
  disabled = false,
  onChanged,
}: {
  revision: number;
  disabled?: boolean;
  onChanged: (configured: boolean) => void;
}) {
  const fieldId = useId();
  const [saved, setSaved] = useState<OpenAIImageConnectionSettings>();
  const [form, setForm] = useState<SaveOpenAIImageConnectionRequest>({
    mode: "separate",
    baseUrl: DEFAULT_BASE_URL,
    models: [],
  });
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [editingConnection, setEditingConnection] = useState<
    "mode" | "key" | "url"
  >();
  const [editingModel, setEditingModel] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualTemplate, setManualTemplate] =
    useState<OpenAIImageModelConfiguration["template"]>("gpt-image-2");
  const [query, setQuery] = useState("");
  const discovery = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const baseline = useRef<SaveOpenAIImageConnectionRequest | undefined>(
    undefined,
  );

  function reset(settings: OpenAIImageConnectionSettings): void {
    setSaved(settings);
    const next: SaveOpenAIImageConnectionRequest = {
      mode:
        settings.mode === "connection" && !settings.connectionAvailable
          ? "separate"
          : settings.mode,
      baseUrl: settings.baseUrl,
      models: settings.models,
    };
    baseline.current = next;
    setForm(next);
    setEditing(false);
    setEditingConnection(undefined);
    setEditingModel(undefined);
    setAdding(false);
    setRemoving(false);
    setManualId("");
    setQuery("");
  }
  useEffect(() => {
    const currentGeneration = ++generation.current;
    discovery.current?.abort();
    setSaved(undefined);
    setEditing(false);
    setFetching(false);
    setBusy(false);
    setError(undefined);
    setNotice(undefined);
    void getOpenAIImageSettings()
      .then((settings) => {
        if (currentGeneration === generation.current) reset(settings);
      })
      .catch((cause) => {
        if (currentGeneration === generation.current)
          setError(errorMessage(cause));
      });
    return () => {
      ++generation.current;
      discovery.current?.abort();
    };
  }, [revision]);

  function field<K extends keyof SaveOpenAIImageConnectionRequest>(
    key: K,
    value: SaveOpenAIImageConnectionRequest[K],
  ): void {
    discovery.current?.abort();
    setFetching(false);
    setError(undefined);
    setNotice(undefined);
    const changesConnection = key === "mode" || key === "baseUrl";
    if (changesConnection) setEditingModel(undefined);
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(changesConnection ? { models: [] } : {}),
    }));
  }
  function editConnection(setting: "mode" | "key" | "url"): void {
    setEditing(true);
    setEditingConnection(setting);
    setAdding(false);
    setEditingModel(undefined);
    setError(undefined);
    setNotice(undefined);
  }
  function cancel(): void {
    discovery.current?.abort();
    setFetching(false);
    if (saved) reset(saved);
    setError(undefined);
    setNotice(undefined);
  }
  async function fetchModels(): Promise<void> {
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    setFetching(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const loaded = await discoverOpenAIImageModels(
        { mode: form.mode, baseUrl: form.baseUrl, apiKey: form.apiKey },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setForm((current) => {
        const existingIds = new Set(current.models.map((model) => model.id));
        return {
          ...current,
          models: [
            ...current.models,
            ...loaded.models.filter((model) => !existingIds.has(model.id)),
          ],
        };
      });
      setNotice(
        [
          t("openAIImages.fetched", { count: loaded.models.length }),
          ...(loaded.warnings ?? []),
        ].join(" "),
      );
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setFetching(false);
    }
  }
  function save(event: FormEvent): void {
    event.preventDefault();
    void persist(() => saveOpenAIImageSettings(form), t("openAIImages.saved"));
  }
  async function persist(
    operation: () => Promise<OpenAIImageConnectionSettings>,
    message: string,
  ): Promise<void> {
    const currentGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    discovery.current?.abort();
    setFetching(false);
    try {
      const settings = await operation();
      if (currentGeneration !== generation.current) return;
      reset(settings);
      setNotice(message);
      onChanged(
        settings.mode === "separate"
          ? settings.configured
          : settings.mode === "connection" && settings.connectionAvailable,
      );
    } catch (cause) {
      if (currentGeneration === generation.current)
        setError(errorMessage(cause));
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  }
  function addModel(): void {
    const id = manualId.trim();
    if (!id || /\s/.test(id)) {
      setError(t("openAIImages.invalidModelId"));
      return;
    }
    if (form.models.some((model) => model.id === id)) {
      setError(t("openAIImages.duplicateModelId"));
      return;
    }
    field("models", [
      ...form.models,
      { id, name: id, template: manualTemplate, enabled: true },
    ]);
    setAdding(false);
    setManualId("");
    setQuery("");
  }
  const locked = disabled || busy;
  const sameEndpoint =
    form.baseUrl.replace(/\/+$/, "") === saved?.baseUrl.replace(/\/+$/, "");
  const canFetch =
    form.mode === "connection"
      ? saved?.connectionAvailable
      : form.mode === "separate" &&
        Boolean(form.apiKey?.trim() || (saved?.configured && sameEndpoint));
  const original = baseline.current;
  const dirty =
    original &&
    (form.apiKey?.trim() ||
      form.mode !== original.mode ||
      form.baseUrl !== original.baseUrl ||
      JSON.stringify(form.models) !== JSON.stringify(original.models));
  const models = form.models.filter(
    (model) =>
      (editing || model.enabled) &&
      `${model.name} ${model.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const connected =
    saved?.mode === "separate"
      ? saved.configured
      : saved?.mode === "connection" && saved.connectionAvailable;
  const enabledCount = form.models.filter((model) => model.enabled).length;
  const changeModel = (
    id: string,
    patch: Partial<OpenAIImageModelConfiguration>,
  ) =>
    field(
      "models",
      form.models.map((model) =>
        model.id === id ? { ...model, ...patch } : model,
      ),
    );

  return (
    <section
      className={`settings-detail-section provider-models${editing ? " is-editing" : ""}`}
      aria-label={t("providers.imageModels")}
    >
      <div className="provider-models-heading">
        <h4>
          {t("providers.imageModels")}{" "}
          <small>{saved ? enabledCount : ""}</small>
        </h4>
        {saved ? (
          <div className="provider-models-heading-actions">
            {editing ? (
              form.mode !== "disabled" ? (
                <>
                  <button
                    className="settings-secondary-button"
                    type="button"
                    disabled={locked || fetching || !canFetch}
                    onClick={() => void fetchModels()}
                  >
                    <RefreshCw
                      size={13}
                      className={fetching ? "spin" : undefined}
                    />
                    {fetching
                      ? t("customProvider.fetching")
                      : t("openAIImages.fetchModels")}
                  </button>
                  <button
                    className="settings-secondary-button"
                    type="button"
                    disabled={locked || fetching}
                    aria-expanded={adding}
                    onClick={() => {
                      setAdding(!adding);
                      setEditingModel(undefined);
                    }}
                  >
                    <Plus size={13} />
                    {t("models.add")}
                  </button>
                </>
              ) : null
            ) : (
              <button
                className="settings-secondary-button"
                type="button"
                aria-label={
                  connected
                    ? t("openAIImages.editModels")
                    : t("openAIImages.connectModels")
                }
                disabled={locked}
                onClick={() => {
                  if (connected) {
                    setEditing(true);
                    setError(undefined);
                    setNotice(undefined);
                  } else editConnection("mode");
                }}
              >
                {connected ? <Pencil size={13} /> : <Plus size={13} />}
                {connected ? t("common.edit") : t("providers.action.connect")}
              </button>
            )}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="settings-success" role="status">
          {notice}
        </p>
      ) : null}
      {!saved ? (
        !error ? (
          <div className="settings-loading">
            <LoaderCircle size={16} className="spin" />
            {t("openAIImages.loading")}
          </div>
        ) : null
      ) : (
        <form
          className="settings-detail-section"
          onSubmit={(event) => void save(event)}
        >
          {editingConnection ? (
            <div className="settings-provider-setting-editor settings-detail-section">
              <label
                className="settings-detail-field"
                htmlFor={`${fieldId}-connection`}
              >
                <span className="settings-search-field-label">
                  {t("openAIImages.imageConnection")}
                </span>
                <select
                  id={`${fieldId}-connection`}
                  className="settings-search-input"
                  value={form.mode}
                  autoFocus={editingConnection === "mode"}
                  disabled={locked}
                  onChange={(event) =>
                    field(
                      "mode",
                      event.target
                        .value as SaveOpenAIImageConnectionRequest["mode"],
                    )
                  }
                >
                  <option value="separate">{t("openAIImages.separate")}</option>
                  <option
                    value="connection"
                    disabled={!saved.connectionAvailable}
                  >
                    {saved.connectionAvailable
                      ? t("openAIImages.useChat")
                      : t("openAIImages.chatKeyRequired")}
                  </option>
                  <option value="disabled">{t("common.disabled")}</option>
                </select>
              </label>
              {form.mode === "separate" ? (
                <div className="provider-model-form-grid">
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-key`}
                  >
                    <span className="settings-search-field-label">
                      {t("openAIImages.imageKey")}
                      {saved.configured && sameEndpoint
                        ? ` · ${t("openAIImages.configured")}`
                        : ""}
                    </span>
                    <input
                      id={`${fieldId}-key`}
                      className="settings-search-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={form.apiKey ?? ""}
                      autoFocus={editingConnection === "key"}
                      disabled={locked}
                      maxLength={16_384}
                      required={!saved.configured || !sameEndpoint}
                      placeholder={
                        saved.configured && sameEndpoint
                          ? t("openAIImages.keepKey")
                          : t("openAIImages.keyPlaceholder")
                      }
                      onChange={(event) => field("apiKey", event.target.value)}
                    />
                  </label>
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-url`}
                  >
                    <span className="settings-search-field-label">
                      {t("openAIImages.imageUrl")}
                    </span>
                    <input
                      id={`${fieldId}-url`}
                      className="settings-search-input"
                      type="url"
                      required
                      value={form.baseUrl}
                      autoFocus={editingConnection === "url"}
                      disabled={locked}
                      placeholder={DEFAULT_BASE_URL}
                      onChange={(event) => field("baseUrl", event.target.value)}
                    />
                  </label>
                </div>
              ) : form.mode === "connection" ? (
                <p className="settings-detail-hint">
                  {t("openAIImages.chatEndpoint", {
                    baseUrl: saved.connectionBaseUrl,
                  })}
                </p>
              ) : null}
              <p className="settings-detail-hint">
                {t("openAIImages.billingHint")}
              </p>
            </div>
          ) : connected || form.mode === "disabled" || editing ? (
            <div>
              {[
                {
                  label: t("openAIImages.connection"),
                  value:
                    form.mode === "separate"
                      ? t("openAIImages.separateKey")
                      : form.mode === "connection"
                        ? t("openAIImages.chatConnection")
                        : t("common.disabled"),
                  setting: "mode" as const,
                  ariaLabel: t("openAIImages.editConnection"),
                },
                ...(form.mode === "separate"
                  ? [
                      {
                        label: t("providers.apiKey"),
                        value: "••••••••",
                        setting: "key" as const,
                        ariaLabel: t("openAIImages.editKey"),
                      },
                    ]
                  : []),
                ...(form.mode !== "disabled"
                  ? [
                      {
                        label: t("providers.baseUrl"),
                        value:
                          form.mode === "connection"
                            ? (saved.connectionBaseUrl ??
                              t("providers.unavailable"))
                            : form.baseUrl,
                        setting: "url" as const,
                        ariaLabel: t("openAIImages.editUrl"),
                      },
                    ]
                  : []),
              ].map((row) => (
                <div
                  className="settings-provider-setting-row"
                  key={row.setting}
                >
                  <span className="settings-search-field-label">
                    {row.label}
                  </span>
                  <span
                    className="settings-provider-setting-value"
                    title={row.value}
                  >
                    {row.value}
                  </span>
                  {row.setting !== "url" || form.mode === "separate" ? (
                    <button
                      className="icon-button settings-provider-setting-edit"
                      type="button"
                      disabled={locked}
                      aria-label={row.ariaLabel}
                      data-tooltip={row.ariaLabel}
                      onClick={() => editConnection(row.setting)}
                    >
                      <Pencil size={15} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="settings-detail-hint">
              {t("openAIImages.connectHint")}
            </p>
          )}
          {form.mode !== "disabled" && (connected || editing) ? (
            <>
              {editing || enabledCount > 5 ? (
                <div className="provider-models-controls">
                  <label className="settings-provider-search">
                    <Search size={14} />
                    <input
                      aria-label={t("openAIImages.search")}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("openAIImages.search")}
                    />
                  </label>
                </div>
              ) : null}
              {adding ? (
                <div className="provider-model-form">
                  <label
                    className="settings-detail-field"
                    htmlFor={`${fieldId}-model`}
                  >
                    <span className="settings-search-field-label">
                      {t("models.modelId")}
                    </span>
                    <input
                      id={`${fieldId}-model`}
                      className="settings-search-input"
                      autoFocus
                      maxLength={200}
                      value={manualId}
                      disabled={locked}
                      onChange={(event) => {
                        const id = event.target.value;
                        setManualId(id);
                        if (/^gpt-image-1(?:[.-]|$)/.test(id))
                          setManualTemplate("gpt-image-1");
                        else if (/^gpt-image-2(?:[.-]|$)/.test(id))
                          setManualTemplate("gpt-image-2");
                      }}
                      placeholder={t("openAIImages.modelPlaceholder")}
                    />
                  </label>
                  <TemplateField
                    id={`${fieldId}-template`}
                    value={manualTemplate}
                    disabled={locked}
                    onChange={setManualTemplate}
                  />
                  <div className="settings-form-actions">
                    <button
                      className="settings-secondary-button"
                      type="button"
                      disabled={locked}
                      onClick={() => setAdding(false)}
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      className="settings-primary-button"
                      type="button"
                      disabled={locked || !manualId.trim()}
                      onClick={addModel}
                    >
                      {t("common.add")}
                    </button>
                  </div>
                </div>
              ) : null}
              <div
                className="provider-models-list"
                role="list"
                aria-label={t("openAIImages.configuredModels")}
                aria-busy={fetching}
              >
                {models.map((model) => {
                  const copy = (
                    <span className="provider-model-copy">
                      <strong title={model.name}>{model.name}</strong>
                      {model.name !== model.id ? (
                        <small title={model.id}>{model.id}</small>
                      ) : null}
                    </span>
                  );
                  return (
                    <Fragment key={model.id}>
                      <div
                        className={`provider-model-row${model.enabled ? "" : " is-hidden"}`}
                        role="listitem"
                      >
                        {editing ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={model.enabled}
                              disabled={locked || fetching}
                              aria-label={t("providers.enableProvider", {
                                name: model.name,
                              })}
                              onChange={(event) =>
                                changeModel(model.id, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            {copy}
                          </label>
                        ) : (
                          <div className="provider-model-readonly">{copy}</div>
                        )}
                        {editing ? (
                          <>
                            <button
                              className="icon-button"
                              type="button"
                              disabled={locked || fetching || adding}
                              aria-label={t("common.editName", {
                                name: model.name,
                              })}
                              data-tooltip={t("common.editName", {
                                name: model.name,
                              })}
                              aria-expanded={editingModel === model.id}
                              onClick={() =>
                                setEditingModel(
                                  editingModel === model.id
                                    ? undefined
                                    : model.id,
                                )
                              }
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="icon-button provider-model-delete"
                              type="button"
                              disabled={locked || fetching}
                              aria-label={t("common.removeName", {
                                name: model.id,
                              })}
                              data-tooltip={t("common.removeName", {
                                name: model.id,
                              })}
                              onClick={() => {
                                field(
                                  "models",
                                  form.models.filter(
                                    (entry) => entry.id !== model.id,
                                  ),
                                );
                                if (editingModel === model.id)
                                  setEditingModel(undefined);
                              }}
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : null}
                      </div>
                      {editing && editingModel === model.id ? (
                        <div className="provider-model-form">
                          <TemplateField
                            id={`${fieldId}-edit-template`}
                            modelId={model.id}
                            value={model.template}
                            disabled={locked || fetching}
                            onChange={(template) =>
                              changeModel(model.id, { template })
                            }
                          />
                        </div>
                      ) : null}
                    </Fragment>
                  );
                })}
                {!models.length ? (
                  <p className="settings-empty">
                    {query.trim()
                      ? t("openAIImages.noMatch")
                      : editing
                        ? t("openAIImages.empty")
                        : t("openAIImages.noneEnabled")}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          {editing ? (
            <div className="provider-model-form-footer">
              {saved.configured || saved.models.length > 0 ? (
                <button
                  className="icon-button provider-model-delete"
                  type="button"
                  aria-label={t("openAIImages.removeConnection")}
                  data-tooltip={t("openAIImages.removeConnection")}
                  disabled={locked || fetching}
                  onClick={() => setRemoving(true)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
              <div className="provider-model-form-actions">
                <button
                  className="settings-secondary-button"
                  type="button"
                  disabled={locked}
                  onClick={cancel}
                >
                  {t("common.cancel")}
                </button>
                <button
                  className="settings-primary-button"
                  type="submit"
                  disabled={locked || fetching || !dirty}
                >
                  {busy ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </div>
          ) : null}
          {removing ? (
            <div className="settings-provider-delete-confirmation">
              <span>{t("openAIImages.removeConfirmation")}</span>
              <button
                className="settings-danger-button"
                type="button"
                disabled={locked}
                onClick={() =>
                  void persist(
                    removeOpenAIImageSettings,
                    t("openAIImages.removed"),
                  )
                }
              >
                {t("openAIImages.remove")}
              </button>
              <button
                className="settings-secondary-button"
                type="button"
                disabled={locked}
                onClick={() => setRemoving(false)}
              >
                {t("common.cancel")}
              </button>
            </div>
          ) : null}
        </form>
      )}
    </section>
  );
}

function TemplateField({
  id,
  modelId,
  value,
  disabled,
  onChange,
}: {
  id: string;
  modelId?: string;
  value: OpenAIImageModelConfiguration["template"];
  disabled: boolean;
  onChange: (template: OpenAIImageModelConfiguration["template"]) => void;
}) {
  return (
    <label className="settings-detail-field" htmlFor={id}>
      <span className="settings-search-field-label">
        {t("openAIImages.template")}
      </span>
      <select
        id={id}
        className="settings-search-input"
        aria-label={
          modelId ? t("openAIImages.templateFor", { modelId }) : undefined
        }
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(
            event.target.value as OpenAIImageModelConfiguration["template"],
          )
        }
      >
        {(["gpt-image-1", "gpt-image-2"] as const).map((template) => (
          <option key={template} value={template}>
            {templateName(template)}
          </option>
        ))}
      </select>
    </label>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
