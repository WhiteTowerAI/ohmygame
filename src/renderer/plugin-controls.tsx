import { useEffect, useRef, useState } from "react";
import type {
  PluginConfigurationValues,
  PluginConfigurationView,
  PluginDetail,
  PluginMcpResult,
} from "../shared/plugins.js";
import type { PluginSetupState } from "../shared/plugin-setup.js";
import type { AgentModelCatalog } from "../shared/contracts.js";
import {
  abortPluginSetup,
  createMcpPlugin,
  createPluginSetup,
  listModels,
  promptPluginSetup,
  readPluginConfiguration,
  readPluginMcpDefinition,
  readPluginSetup,
  savePluginConfiguration,
  savePluginMcpDefinition,
  testPluginMcp,
} from "./api.js";
import { MarkdownContent } from "./markdown-content.js";
import { LoaderCircle, Plug, WandSparkles } from "./icons.js";

export function PluginConfigurationPanel({
  plugin,
  onChanged,
}: {
  plugin: PluginDetail;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<PluginConfigurationView>();
  const [values, setValues] = useState<PluginConfigurationValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    void readPluginConfiguration(plugin.id)
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
  }, [plugin.id]);
  if (config && !Object.keys(config.fields).length) return null;
  if (!config && !Object.keys(plugin.configuration ?? {}).length) return null;
  return (
    <section className="plugin-components plugin-configuration">
      <h2>Configuration</h2>
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
              <label key={key}>
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
                    <option value="">Choose an option</option>
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
                        ? "Configured — enter a value to replace"
                        : field.type === "path"
                          ? "Absolute path"
                          : undefined
                    }
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.value }))
                    }
                  />
                )}
                {field.description ? <small>{field.description}</small> : null}
                {field.type === "secret" &&
                config.configuredSecrets.includes(key) ? (
                  <button
                    className="plugin-detail-secondary"
                    type="button"
                    onClick={() => setValues((v) => ({ ...v, [key]: null }))}
                  >
                    {values[key] === null
                      ? "Will be cleared"
                      : "Clear saved value"}
                  </button>
                ) : null}
              </label>
            );
          })}
          {config.missing.length ? (
            <p role="status">
              Needs configuration:{" "}
              {config.missing
                .map((key) => config.fields[key]?.label)
                .join(", ")}
            </p>
          ) : null}
          <button
            className="plugin-detail-primary"
            type="submit"
            disabled={busy || !Object.keys(values).length}
          >
            {busy ? "Saving…" : "Save configuration"}
          </button>
        </form>
      ) : (
        <p>Loading configuration…</p>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      setConfig(await savePluginConfiguration(plugin.id, values));
      setValues({});
      setNotice(
        "Saved. Active conversations apply changes after the current turn finishes.",
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
      <h2>MCP services</h2>
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
                    ? `Connected · ${server.toolCount ?? 0} tools`
                    : server.status === "not-configured"
                      ? "Needs configuration"
                      : server.status === "disabled"
                        ? "Disabled"
                        : server.status === "needs-auth"
                          ? "Authorization required"
                          : server.status === "failed"
                            ? "Connection failed"
                            : "Ready to connect"}
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
                Test
              </button>
              <button
                className="plugin-switch"
                role="switch"
                type="button"
                aria-label={`Enable ${server.name}`}
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
                    ? `Connected · ${result.toolCount} tools`
                    : result.status === "needs-auth"
                      ? "Authorization required"
                      : "Connection failed"}
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
                Edit configuration
              </button>
              {server.transport === "http" ? (
                <button
                  className="plugin-detail-secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void run(server.id, "auth-start")}
                >
                  Authorize
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
                  MCP service configuration
                  <textarea
                    aria-label="MCP service configuration"
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
                    Cancel
                  </button>
                  <button
                    className="plugin-detail-primary"
                    type="submit"
                    disabled={Boolean(busy)}
                  >
                    Save configuration
                  </button>
                </div>
                <small>
                  Saved credentials are referenced by configuration fields.
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
                  Open authorization page
                </a>
                <label>
                  After authorizing, paste the callback URL or code
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
                  Complete authorization
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
                ? "Provider is not installed"
                : connection.enabled
                  ? "Provided by another plugin"
                  : "Provider is disabled"}
            </span>
          </span>
          {connection.ownerPluginId ? (
            <a
              href={`#/settings/plugins/${encodeURIComponent(connection.ownerPluginId)}`}
            >
              Manage provider
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
        Set up or repair with AI
      </button>
      {error ? <p role="alert">{error}</p> : null}
      <p className="plugin-change-notice">
        Changes apply after the current conversation turn finishes.
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
        aria-label="Add MCP plugin"
        onSubmit={(event) => {
          event.preventDefault();
          void install();
        }}
      >
        <h2>Add MCP plugin</h2>
        <label>
          Plugin name
          <input
            required
            placeholder="my-service"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Connection type
          <select
            value={transport}
            onChange={(event) =>
              setTransport(event.target.value as typeof transport)
            }
          >
            <option value="http">HTTP</option>
            <option value="stdio">Local command</option>
            <option value="json">Paste MCP configuration</option>
          </select>
        </label>
        {transport === "http" ? (
          <label>
            MCP URL
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
              Command
              <input
                required
                value={command}
                placeholder="npx"
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label>
              Arguments (JSON array)
              <textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label>
            MCP configuration
            <textarea
              rows={8}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
          </label>
        )}
        <details>
          <summary>Configuration fields</summary>
          <label>
            Optional field definitions (JSON)
            <textarea
              rows={5}
              value={schema}
              onChange={(event) => setSchema(event.target.value)}
            />
          </label>
        </details>
        <p>
          API keys in environment variables or headers are stored separately
          from the plugin package.
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
            Cancel
          </button>
          <button
            className="plugin-detail-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? "Adding…" : "Add plugin"}
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

export function PluginAssistantDialog({
  pluginId,
  onClose,
  onChanged,
}: {
  pluginId?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [state, setState] = useState<PluginSetupState>();
  const [catalog, setCatalog] = useState<AgentModelCatalog>();
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const storageKey = `ohmygame.plugin-setup.${pluginId ?? "new"}`;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = localStorage.getItem(storageKey);
        const session = saved
          ? await readPluginSetup(saved).catch(() =>
              createPluginSetup(pluginId),
            )
          : await createPluginSetup(pluginId);
        if (!active) return;
        localStorage.setItem(storageKey, session.id);
        setState(session);
        const models = await listModels();
        if (!active) return;
        setCatalog(models);
        const selected = models.defaultModel ?? models.models[0];
        if (selected) setModel(`${selected.provider}\n${selected.id}`);
      } catch (cause) {
        if (active) setError(message(cause));
      }
    })();
    return () => {
      active = false;
    };
  }, [storageKey, pluginId]);
  useEffect(() => {
    if (!state?.busy) return;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void readPluginSetup(state.id)
        .then((next) => {
          if (!active) return;
          setError(undefined);
          setState(next);
          if (!next.busy) onChangedRef.current();
        })
        .catch((cause) => {
          if (active) setError(message(cause));
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [state?.id, state?.busy]);
  useEffect(() => {
    if (state?.pluginId)
      localStorage.setItem(`ohmygame.plugin-setup.${state.pluginId}`, state.id);
  }, [state?.pluginId, state?.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [state?.messages.length]);
  return (
    <div className="plugin-install-backdrop">
      <section
        className="plugin-assistant-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Plugin assistant"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <h2>
            {pluginId ? "Set up or repair plugin" : "Create plugin with AI"}
          </h2>
          <button
            className="plugin-detail-secondary"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </header>
        <p>
          Describe the service or workflow. Enter credentials in the plugin's
          configuration form.
        </p>
        <div className="plugin-assistant-messages" aria-live="polite">
          {state?.messages.map((item, i) => (
            <div className={`plugin-assistant-message is-${item.role}`} key={i}>
              <strong>{item.role === "user" ? "You" : "Assistant"}</strong>
              <MarkdownContent text={item.text} />
            </div>
          ))}
          {state?.busy ? (
            <div className="plugin-assistant-activity">
              <LoaderCircle className="spin" size={14} />
              <span>
                {state.activity &&
                !["plugin_manage", "read", "write", "edit", "bash"].includes(
                  state.activity,
                )
                  ? state.activity
                  : "Working on the plugin…"}
              </span>
            </div>
          ) : null}
          <div ref={bottom} />
        </div>
        {state?.pluginId ? (
          <a
            href={`#/settings/plugins/${encodeURIComponent(state.pluginId)}`}
            onClick={onClose}
          >
            Open plugin configuration
          </a>
        ) : null}
        {error || state?.error ? (
          <p role="alert">{error ?? state?.error}</p>
        ) : null}
        {catalog && !catalog.models.length ? (
          <p>
            No model is available.{" "}
            <a href="#/settings/providers">Configure a provider</a> to use the
            assistant.
          </p>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only">Plugin request</label>
          <textarea
            aria-label="Plugin request"
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Connect this MCP service, or create a Skill for…"
            disabled={state?.busy || sending}
          />
          <footer>
            <select
              aria-label="Assistant model"
              value={model}
              disabled={state?.busy}
              onChange={(event) => setModel(event.target.value)}
            >
              {catalog?.models.map((item) => (
                <option
                  key={`${item.provider}/${item.id}`}
                  value={`${item.provider}\n${item.id}`}
                >
                  {item.providerName} · {item.name}
                </option>
              ))}
            </select>
            {state?.busy ? (
              <button
                className="plugin-detail-secondary"
                type="button"
                onClick={() =>
                  void abortPluginSetup(state.id).catch((cause) =>
                    setError(message(cause)),
                  )
                }
              >
                Stop
              </button>
            ) : (
              <button
                className="plugin-detail-primary"
                type="submit"
                disabled={!state || !model || !prompt.trim() || sending}
              >
                Send
              </button>
            )}
          </footer>
        </form>
      </section>
    </div>
  );
  async function send() {
    if (!state || !model || !prompt.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const [provider, id] = model.split("\n");
      setState(
        await promptPluginSetup(state.id, prompt, {
          provider: provider!,
          id: id!,
        }),
      );
      setPrompt("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSending(false);
    }
  }
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Something went wrong";
}
