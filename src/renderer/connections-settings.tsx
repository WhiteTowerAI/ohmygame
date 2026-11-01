import { useEffect, useState } from "react";
import type { ConnectionSummary } from "../shared/connections.js";
import type { McpServerDefinition, PluginMcpResult } from "../shared/plugins.js";
import {
  createConnection,
  deleteConnection,
  listConnections,
  readConnectionConfiguration,
  readConnectionDefinition,
  saveConnectionConfiguration,
  saveConnectionDefinition,
  testConnection,
  updateConnection,
} from "./api.js";
import { t } from "./i18n.js";
import { Plug } from "./icons.js";
import { PluginConfigurationPanel } from "./plugin-controls.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "./ui/index.js";

/** Settings → Connections: the person's own MCP servers, available to every project's agent. */
export function ConnectionsSettings() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [connections, setConnections] = useState<ConnectionSummary[]>();
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string>();

  async function refresh() {
    try {
      setConnections(await listConnections());
      setError(undefined);
    } catch (cause) {
      setError(message(cause));
    }
  }
  useEffect(() => {
    void refresh();
  }, [serviceGeneration]);

  return (
    <>
      <SettingsGroup
        title={t("connections.title")}
        description={t("connections.description")}
        actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}>{t("connections.add")}</Button>}
      >
        {!connections ? (
          <div className="settings-loading-row">{t("connections.loading")}</div>
        ) : !connections.length ? (
          <SettingsRow title={t("connections.empty")} description={t("connections.emptyHint")} />
        ) : connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            connection={connection}
            open={open === connection.id}
            onOpen={() => setOpen(open === connection.id ? undefined : connection.id)}
            onChanged={refresh}
          />
        ))}
      </SettingsGroup>
      {error ? <SettingsNote tone="danger" role="alert">{error}</SettingsNote> : null}
      <SettingsNote>{t("pluginControls.changesApply")}</SettingsNote>
      {adding ? <AddConnectionDialog onClose={() => setAdding(false)} onCreated={() => void refresh()} onAdded={(id) => { setAdding(false); setOpen(id); void refresh(); }} /> : null}
    </>
  );
}

function ConnectionRow({ connection, open, onOpen, onChanged }: {
  connection: ConnectionSummary;
  open: boolean;
  onOpen: () => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<PluginMcpResult>();
  const [definition, setDefinition] = useState<string>();
  const [callback, setCallback] = useState("");
  // A new definition can add or drop credential fields; the panel reloads them.
  const [definitionVersion, setDefinitionVersion] = useState(0);

  return (
    <div className="connection-item">
      <SettingsRow
        icon={<Plug size={16} />}
        title={connection.displayName}
        description={statusText(connection)}
        onClick={onOpen}
      >
        <Button size="sm" variant="ghost" onClick={onOpen} aria-expanded={open}>{t("connections.manage")}</Button>
        <Switch
          size="sm"
          label={t("plugins.enableName", { name: connection.displayName })}
          checked={connection.enabled}
          disabled={busy}
          onChange={(enabled) => void act(async () => {
            await updateConnection(connection.id, { enabled });
          })}
        />
      </SettingsRow>
      {open ? (
        <div className="connection-detail">
          <div className="connection-actions">
            <Button size="sm" disabled={busy} onClick={() => void run("test")}>{t("pluginControls.test")}</Button>
            {connection.transport === "http" ? <Button size="sm" disabled={busy} onClick={() => void run("auth-start")}>{t("pluginControls.authorize")}</Button> : null}
            <Button size="sm" disabled={busy} onClick={() => void edit()}>{t("pluginControls.editConfiguration")}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>{t("connections.delete")}</Button>
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
          {result?.authorizationUrl ? (
            <div className="plugin-oauth">
              <a href={result.authorizationUrl} target="_blank" rel="noreferrer">{t("pluginControls.openAuthorization")}</a>
              <Field label={t("pluginControls.pasteCallback")}>
                {(props) => <Input {...props} value={callback} autoComplete="off" onChange={(event) => setCallback(event.target.value)} />}
              </Field>
              <Button size="sm" disabled={busy || !callback.trim()} onClick={() => void run("auth-complete")}>{t("pluginControls.completeAuthorization")}</Button>
            </div>
          ) : null}
          {definition !== undefined ? (
            <form className="connection-editor" onSubmit={(event) => { event.preventDefault(); void saveDefinition(); }}>
              <Field label={t("pluginControls.mcpConfiguration")} hint={t("pluginControls.credentialsReferenced")}>
                {(props) => <Textarea {...props} rows={10} value={definition} onChange={(event) => setDefinition(event.target.value)} />}
              </Field>
              <div className="connection-actions">
                <Button size="sm" onClick={() => setDefinition(undefined)}>{t("common.cancel")}</Button>
                <Button size="sm" variant="primary" type="submit" disabled={busy}>{t("pluginControls.saveConfiguration")}</Button>
              </div>
            </form>
          ) : null}
          <PluginConfigurationPanel
            key={definitionVersion}
            plugin={{ id: `connection:${connection.id}`, configuration: {} }}
            compact
            load={() => readConnectionConfiguration(connection.id)}
            store={(values) => saveConnectionConfiguration(connection.id, values)}
            onChanged={() => void onChanged()}
          />
          {error ? <p className="connection-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );

  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await operation();
      await onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  async function run(action: "test" | "auth-start" | "auth-complete") {
    await act(async () => {
      setResult(await testConnection(connection.id, action, action === "auth-complete" ? callback : undefined));
      if (action === "auth-complete") setCallback("");
    });
  }
  async function edit() {
    await act(async () => {
      setDefinition(JSON.stringify((await readConnectionDefinition(connection.id)).definition, null, 2));
    });
  }
  async function saveDefinition() {
    await act(async () => {
      await saveConnectionDefinition(connection.id, JSON.parse(definition ?? "{}") as McpServerDefinition);
      setDefinition(undefined);
      setResult(undefined);
      setDefinitionVersion((version) => version + 1);
    });
  }
  async function remove() {
    if (!window.confirm(t("connections.confirmDelete", { name: connection.displayName }))) return;
    await act(() => deleteConnection(connection.id));
  }
}

function AddConnectionDialog({ onClose, onCreated, onAdded }: { onClose: () => void; onCreated: () => void; onAdded: (id: string) => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio" | "json">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [json, setJson] = useState('{\n  "mcpServers": {}\n}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Pasted servers already added, by name, so a retry after one fails doesn't add them twice.
  const [added, setAdded] = useState<ReadonlyMap<string, string>>(new Map());
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={t("connections.add")}
      description={t("pluginControls.keysStored")}
      footer={<>
        <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
        <Button variant="primary" type="submit" form="add-connection" disabled={busy}>{busy ? t("pluginControls.adding") : t("plugins.add")}</Button>
      </>}
    >
      <form id="add-connection" className="connection-form" onSubmit={(event) => { event.preventDefault(); void add(); }}>
        {transport !== "json" ? (
          <Field label={t("connections.name")}>
            {(props) => <Input {...props} required maxLength={100} placeholder="GitHub" value={name} onChange={(event) => setName(event.target.value)} />}
          </Field>
        ) : null}
        <Field label={t("pluginControls.connectionType")}>
          {(props) => <Select
            id={props.id}
            label={t("pluginControls.connectionType")}
            value={transport}
            onChange={setTransport}
            options={[
              { value: "http", label: "HTTP" },
              { value: "stdio", label: t("pluginControls.localCommand") },
              { value: "json", label: t("pluginControls.pasteConfig") },
            ]}
          />}
        </Field>
        {transport === "http" ? (
          <Field label={t("pluginControls.mcpUrl")}>
            {(props) => <Input {...props} required type="url" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />}
          </Field>
        ) : transport === "stdio" ? (
          <>
            <Field label={t("pluginControls.command")}>
              {(props) => <Input {...props} required placeholder="npx" value={command} onChange={(event) => setCommand(event.target.value)} />}
            </Field>
            <Field label={t("pluginControls.arguments")}>
              {(props) => <Textarea {...props} rows={3} value={args} onChange={(event) => setArgs(event.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label={t("pluginControls.mcpConfig")} hint={t("connections.pasteHint")}>
            {(props) => <Textarea {...props} rows={8} value={json} onChange={(event) => setJson(event.target.value)} />}
          </Field>
        )}
        {error ? <p className="connection-error" role="alert">{error}</p> : null}
      </form>
    </Dialog>
  );

  async function add() {
    setBusy(true);
    setError(undefined);
    try {
      const servers: Array<[string, McpServerDefinition]> = transport === "json"
        ? Object.entries(parseServers(json))
        : [[name.trim(), transport === "http" ? { url } : { command, args: parseArgs(args) }]];
      if (!servers.length) throw new Error(t("connections.noServers"));
      const done = new Map(added);
      try {
        for (const [displayName, definition] of servers) {
          if (done.has(displayName)) continue;
          done.set(displayName, (await createConnection({ displayName, definition })).id);
          onCreated();
        }
      } finally {
        setAdded(done);
      }
      onAdded(done.get(servers[0]![0])!);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
}

/** `{ "mcpServers": { … } }` as other apps write it, or the servers alone. */
function parseServers(text: string): Record<string, McpServerDefinition> {
  const value = JSON.parse(text) as unknown;
  const servers = value && typeof value === "object" && "mcpServers" in value ? (value as { mcpServers: unknown }).mcpServers : value;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(t("connections.noServers"));
  return servers as Record<string, McpServerDefinition>;
}

function parseArgs(text: string): string[] {
  const value = JSON.parse(text.trim() || "[]") as unknown;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(t("connections.argsHint"));
  return value;
}

function statusText(connection: ConnectionSummary): string {
  const status = connection.status === "connected"
    ? t("pluginControls.connectedTools", { count: connection.toolCount ?? 0 })
    : connection.status === "not-configured"
      ? t("plugins.needsConfiguration")
      : connection.status === "disabled"
        ? t("common.disabled")
        : connection.status === "needs-auth"
          ? t("pluginControls.authorizationRequired")
          : connection.status === "failed"
            ? t("providers.status.failed")
            : t("connections.ready");
  const kind = connection.transport === "http" ? "HTTP" : t("pluginControls.localCommand");
  return `${kind} · ${status}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
