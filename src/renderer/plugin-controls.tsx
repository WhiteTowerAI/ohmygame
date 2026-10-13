import { useEffect, useState } from "react";
import type {
  PluginConfigurationValues,
  PluginConfigurationView,
  PluginDetail,
  PluginMcpResult,
} from "../shared/plugins.js";
import {
  createMcpPlugin,
  readPluginDraftConfiguration,
  savePluginDraftConfiguration,
  readPluginConfiguration,
  readPluginMcpDefinition,
  savePluginConfiguration,
  savePluginMcpDefinition,
  testPluginMcp,
} from "./api.js";
import { LoaderCircle, Plug, Trash2, WandSparkles } from "./icons.js";
import { t } from "./i18n.js";

export function PluginUninstallButton({ plugin, disabled, compact = false, onUninstall }: {
  plugin: Pick<PluginDetail, "displayName" | "installed" | "source">;
  disabled?: boolean;
  compact?: boolean;
  onUninstall: () => void;
}) {
  if (!plugin.installed || plugin.source.type === "builtIn") return null;
  return <button className={compact ? "icon-button pane-header-action" : "plugin-detail-secondary"} type="button"
    disabled={disabled} title={t("pluginControls.uninstall")} aria-label={t("pluginControls.uninstall")} onClick={() => {
      if (window.confirm(t("pluginControls.confirmUninstall", { name: plugin.displayName }))) onUninstall();
    }}>{compact ? <Trash2 size={14} /> : t("pluginControls.uninstallShort")}</button>;
}

export function PluginConfigurationPanel({
  plugin,
  setupId,
  compact = false,
  onChanged,
}: {
  plugin: PluginDetail;
  setupId?: string;
  compact?: boolean;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<PluginConfigurationView>();
  const [values, setValues] = useState<PluginConfigurationValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    void (setupId ? readPluginDraftConfiguration(setupId) : readPluginConfiguration(plugin.id))
      .then((value) => {
        if (active) {
          setConfig(value);
          setValues({});
        }
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [plugin.id, setupId]);
  if (config && !Object.keys(config.fields).length) return null;
  if (!config && !Object.keys(plugin.configuration ?? {}).length) return null;
  return (
    <section className="plugin-components plugin-configuration">
      {!compact ? <h2>{t("pluginControls.configuration")}</h2> : null}
      {config ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {Object.entries(config.fields).map(([key, field]) => {
            const value =
              values[key] ?? config.values[key] ?? field.default ?? "";
            return (
              <label key={key} title={compact ? field.description : undefined}>
                <span>
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                {field.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.checked }))
                    }
                  />
                ) : field.type === "select" ? (
                  <select
                    value={String(value)}
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.value }))
                    }
                  >
                    <option value="">{t("pluginControls.chooseOption")}</option>
                    {field.options?.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === "secret" ? "password" : "text"}
                    autoComplete="off"
                    value={
                      field.type === "secret"
                        ? String(values[key] ?? "")
                        : String(value)
                    }
                    placeholder={
                      field.type === "secret" &&
                      config.configuredSecrets.includes(key)
                        ? t("pluginControls.configuredReplace")
                        : field.type === "path"
                          ? t("pluginControls.absolutePath")
                          : undefined
                    }
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.value }))
                    }
                  />
                )}
                {!compact && field.description ? <small>{field.description}</small> : null}
                {field.type === "secret" &&
                config.configuredSecrets.includes(key) ? (
                  <button
                    className="plugin-detail-secondary"
                    type="button"
                    onClick={() => setValues((v) => ({ ...v, [key]: null }))}
                  >
                    {values[key] === null
                      ? t("pluginControls.willClear")
                      : t("pluginControls.clearSaved")}
                  </button>
                ) : null}
              </label>
            );
          })}
          {config.missing.length ? (
            <p role="status">
              {t("pluginControls.needsConfiguration", {
                fields: config.missing
                  .map((key) => config.fields[key]?.label)
                  .join(", "),
              })}
            </p>
          ) : null}
          <button
            className="plugin-detail-primary"
            type="submit"
            disabled={busy || !Object.keys(values).length}
          >
            {busy ? t("common.saving") : t("pluginControls.saveConfiguration")}
          </button>
        </form>
      ) : (
        <p>{t("pluginControls.loadingConfiguration")}</p>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      setConfig(await (setupId ? savePluginDraftConfiguration(setupId, values) : savePluginConfiguration(plugin.id, values)));
      setValues({});
      setNotice(
        compact ? t("common.saved") : setupId ? t("pluginControls.savedDraft") : t("pluginControls.savedActive"),
      );
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
}

export function PluginMcpPanel({
  plugin,
  onToggle,
  onAssist,
  onChanged,
}: {
  plugin: PluginDetail;
  onChanged: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onAssist: () => void;
}) {
  const [results, setResults] = useState<Record<string, PluginMcpResult>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<string>();
  const [definition, setDefinition] = useState("");
  if (!plugin.mcpServers?.length && !plugin.connections.length) return null;
  return (
    <section className="plugin-components">
      <h2>{t("pluginControls.mcpServices")}</h2>
      {(plugin.mcpServers ?? []).map((server) => {
        const result = results[server.id];
        return (
          <div className="plugin-mcp-service" key={server.id}>
            <div className="plugin-component-row plugin-mcp-row">
              <span className="plugin-component-icon">
                <Plug size={15} />
              </span>
              <span className="plugin-row-copy">
                <strong>{server.name}</strong>
                <span>
                  {server.status === "connected"
                    ? t("pluginControls.connectedTools", { count: server.toolCount ?? 0 })
                    : server.status === "not-configured"
                      ? t("plugins.needsConfiguration")
                      : server.status === "disabled"
                        ? t("common.disabled")
                        : server.status === "needs-auth"
                          ? t("pluginControls.authorizationRequired")
                          : server.status === "failed"
                            ? t("providers.status.failed")
                            : t("pluginControls.readyToConnect")}
                </span>
              </span>
              <button
                className="plugin-detail-secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void run(server.id, "test")}
              >
                {busy === server.id ? (
                  <LoaderCircle size={13} className="spin" />
                ) : null}
                {t("pluginControls.test")}
              </button>
              <button
                className="plugin-switch"
                role="switch"
                type="button"
                aria-label={t("plugins.enableName", { name: server.name })}
                aria-checked={server.enabled}
                disabled={!plugin.enabled}
                onClick={() => onToggle(server.id, !server.enabled)}
              >
                <span />
              </button>
            </div>
            {result ? (
              <div className="plugin-mcp-result" role="status">
                <strong>
                  {result.status === "connected"
                    ? t("pluginControls.connectedTools", { count: result.toolCount })
                    : result.status === "needs-auth"
                      ? t("pluginControls.authorizationRequired")
                      : t("providers.status.failed")}
                </strong>
                {result.message ? <pre>{result.message}</pre> : null}
              </div>
            ) : null}
            <div className="plugin-section-actions">
              <button
                className="plugin-detail-secondary"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void edit(server.id)}
              >
                {t("pluginControls.editConfiguration")}
              </button>
              {server.transport === "http" ? (
                <button
                  className="plugin-detail-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(server.id, "auth-start")}
                >
                  {t("pluginControls.authorize")}
                </button>
              ) : null}
            </div>
            {editing === server.id ? (
              <form
                className="plugin-mcp-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveDefinition(server.id);
                }}
              >
                <label>
                  {t("pluginControls.mcpConfiguration")}
                  <textarea
                    aria-label={t("pluginControls.mcpConfiguration")}
                    rows={10}
                    value={definition}
                    onChange={(event) => setDefinition(event.target.value)}
                  />
                </label>
                <div>
                  <button
                    className="plugin-detail-secondary"
                    type="button"
                    onClick={() => setEditing(undefined)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="plugin-detail-primary"
                    type="submit"
                    disabled={Boolean(busy)}
                  >
                    {t("pluginControls.saveConfiguration")}
                  </button>
                </div>
                <small>
                  {t("pluginControls.credentialsReferenced")}
                </small>
              </form>
            ) : null}
            {result?.authorizationUrl ? (
              <div className="plugin-oauth">
                <a
                  href={result.authorizationUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("pluginControls.openAuthorization")}
                </a>
                <label>
                  {t("pluginControls.pasteCallback")}
                  <input
                    value={input}
                    autoComplete="off"
                    onChange={(event) => setInput(event.target.value)}
                  />
                </label>
                <button
                  className="plugin-detail-secondary"
                  type="button"
                  disabled={Boolean(busy) || !input.trim()}
                  onClick={() => void run(server.id, "auth-complete")}
                >
                  {t("pluginControls.completeAuthorization")}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      {plugin.connections.map((connection) => (
        <div className="plugin-component-row" key={connection.id}>
          <span className="plugin-row-copy">
            <strong>{connection.name}</strong>
            <span>
              {connection.status === "not-configured"
                ? t("pluginControls.providerNotInstalled")
                : connection.enabled
                  ? t("pluginControls.providedByAnother")
                  : t("pluginControls.providerDisabled")}
            </span>
          </span>
          {connection.ownerPluginId ? (
            <a
              href={`#/settings/plugins/${encodeURIComponent(connection.ownerPluginId)}`}
            >
              {t("pluginControls.manageProvider")}
            </a>
          ) : null}
        </div>
      ))}
      <button
        className="plugin-detail-secondary"
        type="button"
        onClick={onAssist}
      >
        <WandSparkles size={13} />
        {t("pluginControls.repairWithAi")}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <p className="plugin-change-notice">
        {t("pluginControls.changesApply")}
      </p>
    </section>
  );
  async function edit(server: string) {
    setBusy(server);
    setError(undefined);
    try {
      const result = await readPluginMcpDefinition(plugin.id, server);
      setDefinition(JSON.stringify(result.definition, null, 2));
      setEditing(server);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }
  async function saveDefinition(server: string) {
    setBusy(server);
    setError(undefined);
    try {
      await savePluginMcpDefinition(plugin.id, server, JSON.parse(definition));
      setEditing(undefined);
      setResults({});
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }
  async function run(
    server: string,
    action: "test" | "auth-start" | "auth-complete",
  ) {
    setBusy(server);
    setError(undefined);
    try {
      const result = await testPluginMcp(
        plugin.id,
        server,
        action,
        action === "auth-complete" ? input : undefined,
      );
      setResults((r) => ({ ...r, [server]: result }));
      if (action === "auth-complete") setInput("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }
}

export function AddMcpPluginDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "json">("http");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [url, setUrl] = useState("");
  const [json, setJson] = useState('{\n  "mcpServers": {}\n}');
  const [schema, setSchema] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div
      className="plugin-install-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="plugin-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("pluginControls.addMcpPlugin")}
        onSubmit={(event) => {
          event.preventDefault();
          void install();
        }}
      >
        <h2>{t("pluginControls.addMcpPlugin")}</h2>
        <label>
          {t("pluginControls.pluginName")}
          <input
            required
            placeholder="my-service"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {t("pluginControls.connectionType")}
          <select
            value={transport}
            onChange={(event) =>
              setTransport(event.target.value as typeof transport)
            }
          >
            <option value="http">HTTP</option>
            <option value="stdio">{t("pluginControls.localCommand")}</option>
            <option value="json">{t("pluginControls.pasteConfig")}</option>
          </select>
        </label>
        {transport === "http" ? (
          <label>
            {t("pluginControls.mcpUrl")}
            <input
              required
              type="url"
              value={url}
              placeholder="https://example.com/mcp"
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
        ) : transport === "stdio" ? (
          <>
            <label>
              {t("pluginControls.command")}
              <input
                required
                value={command}
                placeholder="npx"
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label>
              {t("pluginControls.arguments")}
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            {t("pluginControls.mcpConfig")}
            <textarea
              rows={8}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
          </label>
        )}
        <details>
          <summary>{t("pluginControls.configFields")}</summary>
          <label>
            {t("pluginControls.optionalFields")}
            <textarea
              rows={5}
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
            />
          </label>
        </details>
        <p>
          {t("pluginControls.keysStored")}
        </p>
        {error ? (
          <p className="plugin-install-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button
            className="plugin-detail-secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="plugin-detail-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? t("pluginControls.adding") : t("plugins.add")}
          </button>
        </footer>
      </form>
    </div>
  );
  async function install() {
    setBusy(true);
    setError(undefined);
    try {
      const servers =
        transport === "json"
          ? JSON.parse(json).mcpServers
          : {
              service:
                transport === "http"
                  ? { url }
                  : { command, args: JSON.parse(args) },
            };
      const plugin = await createMcpPlugin({
        name,
        servers,
        configuration: JSON.parse(schema),
      });
      onInstalled(plugin.id);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
