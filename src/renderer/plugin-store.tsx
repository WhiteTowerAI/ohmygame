import { useEffect, useState, type ReactNode } from "react";
import type { StorePlugin, StorePluginConfiguration } from "../shared/plugins.js";
import { consentToPlugin, readStorePluginConfiguration, saveStorePluginConfiguration, setStorePluginEnabled, uninstallStorePlugin } from "./api.js";
import { t } from "./i18n.js";
import { PluginGlyph } from "./plugin-icons.js";
import { Alert, Badge, Button, Dialog, Switch } from "./ui/index.js";

// Format 2 plugins on the Plugins page. They are installed for the app and
// turned on in each project, from its Plugins sheet or when it is created;
// here they switch off everywhere, get the person's consent, take their
// settings and uninstall. Several versions can be installed side by side,
// since each project pins its own.

/** An installed plugin: its newest version, and every version installed. */
export interface StorePluginGroup {
  plugin: StorePlugin;
  versions: StorePlugin[];
}

/** Groups the store's rows, which come newest version first, by plugin. */
export function groupStorePlugins(rows: readonly StorePlugin[]): StorePluginGroup[] {
  const groups = new Map<string, StorePluginGroup>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group) group.versions.push(row);
    else groups.set(row.id, { plugin: row, versions: [row] });
  }
  return [...groups.values()];
}

export const storePluginEnabled = (plugin: StorePlugin) => plugin.grants?.enabled !== false;

/** What it asks for that the person hasn't allowed yet. */
export function storePluginMissing(plugin: StorePlugin): string[] {
  const allowed = new Set(plugin.grants?.allowed ?? []);
  return plugin.capabilities.filter((capability) => !allowed.has(capability));
}

export function storePluginSearchText(plugin: StorePlugin): string {
  return `${plugin.displayName} ${plugin.description} ${plugin.id}`.toLowerCase();
}

function StoreTile({ plugin, large = false }: { plugin: StorePlugin; large?: boolean }): ReactNode {
  return <span className={`plugin-tile${large ? " plugin-tile-large" : ""}`}><PluginGlyph plugin={{ id: plugin.id }} size={large ? 40 : 24} /></span>;
}

function StoreTags({ plugin }: { plugin: StorePlugin }): ReactNode {
  const { adds } = plugin;
  return <>
    {adds.projectTypes.map((type) => <span key={`type:${type}`} className="plugins-tag">{type}</span>)}
    {adds.skills ? <span className="plugins-tag">{t("plugins.skillCount", { count: adds.skills })}</span> : null}
    {adds.tools ? <span className="plugins-tag">{t("pluginStore.toolCount", { count: adds.tools })}</span> : null}
    {adds.panels.length ? <span className="plugins-tag">{t("pluginStore.panelCount", { count: adds.panels.length })}</span> : null}
  </>;
}

export function StorePluginCard({ group, disabled, onToggle, onOpen }: {
  group: StorePluginGroup;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}): ReactNode {
  const { plugin } = group;
  const enabled = storePluginEnabled(plugin);
  return <article className={`plugin-card${enabled ? "" : " is-off"}`}>
    <button className="plugin-card-link" type="button" onClick={onOpen}>
      <StoreTile plugin={plugin} />
      <span className="plugin-card-text">
        <strong>
          <span className="plugin-card-name">{plugin.displayName}</span>
          {enabled && storePluginMissing(plugin).length ? <Badge tone="outline">{t("pluginStore.needsConsent")}</Badge> : null}
        </strong>
        <small>{plugin.description}</small>
        <span className="plugins-meta">
          <span>{t("pluginStore.perProject")}</span>
          <StoreTags plugin={plugin} />
        </span>
      </span>
    </button>
    <Switch size="sm" checked={enabled} disabled={disabled}
      label={`${enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={onToggle} />
  </article>;
}

export function StorePluginDetail({ group, onChanged, onRemoved }: {
  group: StorePluginGroup;
  /** The store changed; reload it. */
  onChanged: () => Promise<void>;
  /** Its last version was uninstalled. */
  onRemoved: () => void;
}): ReactNode {
  const { plugin, versions } = group;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<StorePlugin>();
  const enabled = storePluginEnabled(plugin);
  const missing = storePluginMissing(plugin);

  async function act(key: string, work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError(undefined);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }

  const toggle = (on: boolean) => void act("enabled", () => setStorePluginEnabled(plugin.id, on));
  const allow = () => void act("consent", () => consentToPlugin(plugin.id, plugin.capabilities));
  const remove = (version: StorePlugin) => {
    setRemoving(undefined);
    void act(`remove:${version.version}`, async () => {
      await uninstallStorePlugin(plugin.id, version.version);
      if (versions.length === 1) onRemoved();
    });
  };
  const adds = [
    ...plugin.adds.projectTypes.map((title) => ({ kind: t("pluginStore.addsType"), title })),
    ...plugin.adds.panels.map((title) => ({ kind: t("pluginStore.addsPanel"), title })),
    ...plugin.adds.commands.map((title) => ({ kind: t("pluginStore.addsCommand"), title })),
  ];

  return <div className="plugin-page">
    <header className="plugin-head">
      <StoreTile plugin={plugin} large />
      <div className="plugin-head-copy">
        <h1>
          <span>{plugin.displayName}</span>
          {plugin.bundled ? <Badge tone="outline">{t("plugins.included")}</Badge> : null}
        </h1>
        <p>{plugin.description}</p>
      </div>
    </header>
    {error ? <Alert tone="danger" title={error} /> : null}
    {enabled && missing.length ? <Alert title={t("pluginStore.consentTitle")} action={
      <Button size="sm" variant="primary" disabled={!!busy} onClick={allow}>{t("pluginStore.allow")}</Button>
    }>
      {t("pluginStore.consentHint")} {missing.map((capability, index) => <span key={capability}>{index ? ", " : ""}<code>{capability}</code></span>)}
    </Alert> : null}

    <div className="plugin-layout">
      <div className="plugin-main">
        <p className="plugin-long">{t("pluginStore.perProjectHint")}</p>
        {adds.length || plugin.adds.skills || plugin.adds.tools ? <section className="plugins-section" aria-label={t("pluginStore.adds")}>
          <h2>{t("pluginStore.adds")}</h2>
          <ul className="plugin-store-adds">
            {adds.map((item) => <li key={`${item.kind}:${item.title}`}><span>{item.kind}</span>{item.title}</li>)}
            {plugin.adds.skills ? <li><span>{t("plugins.skills")}</span>{t("plugins.skillCount", { count: plugin.adds.skills })}</li> : null}
            {plugin.adds.tools ? <li><span>{t("pluginStore.tools")}</span>{t("pluginStore.toolCount", { count: plugin.adds.tools })}</li> : null}
          </ul>
        </section> : null}
        {plugin.capabilities.length ? <section className="plugins-section" aria-label={t("pluginStore.asksFor")}>
          <h2>{t("pluginStore.asksFor")}</h2>
          <ul className="plugin-store-capabilities">{plugin.capabilities.map((capability) => <li key={capability} className="plugins-tag plugins-mono">{capability}</li>)}</ul>
        </section> : null}
        <StorePluginSettings key={plugin.id + plugin.version} plugin={plugin} />
      </div>
      <aside className="plugin-side" aria-label={t("plugins.management")}>
        <h2>{t("plugins.management")}</h2>
        <dl className="plugin-props">
          <dt>{t("plugins.status")}</dt>
          <dd className="plugin-state">
            <Switch size="sm" checked={enabled} disabled={!!busy}
              label={`${enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`} onChange={toggle} />
            {enabled ? t("common.enabled") : t("common.disabled")}
          </dd>
          <dt>{t("plugins.source")}</dt>
          <dd>{plugin.bundled ? t("plugins.includedWithOhMyGame") : plugin.id}</dd>
          <dt>{versions.length > 1 ? t("pluginStore.versions") : t("plugins.version")}</dt>
          <dd>
            <ul className="plugin-store-versions">
              {versions.map((version) => <li key={version.version}>
                <span className="plugins-mono">v{version.version}</span>
                {!plugin.bundled ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setRemoving(version)}>
                  {t("pluginStore.uninstall")}
                </Button> : null}
              </li>)}
            </ul>
          </dd>
        </dl>
      </aside>
    </div>
    {removing ? <Dialog open title={t("pluginStore.uninstallTitle", { name: plugin.displayName, version: removing.version })} onClose={() => setRemoving(undefined)}
      footer={<>
        <Button variant="ghost" onClick={() => setRemoving(undefined)}>{t("common.cancel")}</Button>
        <Button variant="primary" onClick={() => remove(removing)}>{t("pluginStore.uninstall")}</Button>
      </>}>
      <p>{t("pluginStore.uninstallHint")}</p>
    </Dialog> : null}
  </div>;
}

/** The plugin's settings form. Secrets are never read back, only replaced or cleared. */
function StorePluginSettings({ plugin }: { plugin: StorePlugin }): ReactNode {
  const [config, setConfig] = useState<StorePluginConfiguration>();
  const [values, setValues] = useState<Record<string, string | boolean | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!plugin.settings.length) return;
    let active = true;
    void readStorePluginConfiguration(plugin.id).then(
      (value) => { if (active) setConfig(value); },
      (cause: unknown) => { if (active) setError(message(cause)); },
    );
    return () => { active = false; };
  }, [plugin.id]);
  if (!plugin.settings.length) return null;

  async function save(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setConfig(await saveStorePluginConfiguration(plugin.id, values));
      setValues({});
      setNotice(t("common.saved"));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section className="plugin-components plugin-configuration" aria-label={t("common.settings")}>
    <h2>{t("common.settings")}</h2>
    {config ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {plugin.settings.map((field) => {
        const view = config[field.name];
        const stored = view && view.type !== "secret" ? view.value : null;
        const configured = view?.type === "secret" && view.configured;
        const value = field.name in values ? values[field.name] : stored;
        const set = (next: string | boolean | null) => setValues((current) => ({ ...current, [field.name]: next }));
        // An emptied secret field leaves the saved one alone; Clear removes it.
        const unset = () => setValues(({ [field.name]: _, ...rest }) => rest);
        return <label key={field.name}>
          <span>{field.title}{field.required ? " *" : ""}</span>
          {field.type === "boolean" ? (
            <input type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
          ) : field.type === "select" ? (
            <select value={typeof value === "string" ? value : ""} onChange={(event) => set(event.target.value || null)}>
              <option value="">{t("pluginControls.chooseOption")}</option>
              {field.options?.map((option) => <option key={option}>{option}</option>)}
            </select>
          ) : (
            <input
              type={field.type === "secret" ? "password" : "text"}
              autoComplete="off"
              value={typeof value === "string" ? value : ""}
              placeholder={field.type === "secret" && configured ? t("pluginControls.configuredReplace") : field.type === "path" ? t("pluginControls.absolutePath") : undefined}
              // An emptied field goes back to its default.
              onChange={(event) => event.target.value ? set(event.target.value) : field.type === "secret" ? unset() : set(null)}
            />
          )}
          {field.description ? <small>{field.description}</small> : null}
          {field.type === "secret" && configured ? <button className="plugin-detail-secondary" type="button" onClick={() => set(null)}>
            {values[field.name] === null ? t("pluginControls.willClear") : t("pluginControls.clearSaved")}
          </button> : null}
        </label>;
      })}
      <button className="plugin-detail-primary" type="submit" disabled={busy || !Object.keys(values).length}>
        {busy ? t("common.saving") : t("pluginControls.saveConfiguration")}
      </button>
    </form> : !error ? <p>{t("pluginControls.loadingConfiguration")}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
