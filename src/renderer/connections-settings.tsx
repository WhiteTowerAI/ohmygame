import { useEffect, useState, type FormEvent } from "react";
import type { Connection, ConnectionTransport, SaveConnectionRequest } from "../shared/connections.js";
import { createConnection, listConnections, removeConnection, setConnectionEnabled, updateConnection } from "./api.js";
import { LoaderCircle, Pencil, Plug, Plus, Trash2, X } from "./icons.js";
import { GodotIcon } from "./godot-icon.js";

type EditorState = { mode: "create" | "edit"; connection?: Connection };

export function ConnectionsSettings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [editor, setEditor] = useState<EditorState>();

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      setConnections(await listConnections());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  async function toggle(connection: Connection): Promise<void> {
    setBusy(connection.id);
    setError(undefined);
    try {
      await setConnectionEnabled(connection.id, !connection.enabled);
      setConnections((items) => items.map((item) => item.id === connection.id ? { ...item, enabled: !item.enabled } : item));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function remove(connection: Connection): Promise<void> {
    if (!window.confirm(`Delete “${connection.displayName}”?`)) return;
    setBusy(connection.id);
    setError(undefined);
    try {
      await removeConnection(connection.id);
      setConnections((items) => items.filter((item) => item.id !== connection.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function save(input: SaveConnectionRequest): Promise<void> {
    setBusy(editor?.connection?.id ?? input.id);
    setError(undefined);
    try {
      if (editor?.mode === "edit" && editor.connection) await updateConnection(editor.connection.id, input);
      else await createConnection(input);
      setEditor(undefined);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="settings-panel settings-overview-panel">
    <header className="settings-panel-header">
      <h3>Connections</h3>
      <button className="settings-primary-button" type="button" onClick={() => setEditor({ mode: "create" })}><Plus size={14} />Add connection</button>
    </header>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {phase === "loading" ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />Loading connections</div> : null}
    {phase === "error" ? <button className="settings-secondary-button" type="button" onClick={() => void load()}>Retry</button> : null}
    {phase === "ready" ? <div className="settings-connection-list">
      {connections.map((connection) => <article className={`settings-connection-row${connection.enabled ? "" : " is-disabled"}`} key={connection.id}>
        <span className="settings-connection-icon">{connection.id === "opengame-godot" ? <GodotIcon size={20} /> : <Plug size={17} />}</span>
        <span className="settings-connection-copy">
          <span><strong>{connection.displayName}</strong>{connection.source === "preset" ? <small>Built-in</small> : null}</span>
          <span className="settings-connection-transport" title={connectionDefinition(connection)}>{connection.transport.type === "stdio" ? "Local · STDIO" : "Remote · HTTP"}</span>
        </span>
        {connection.editable ? <button className="settings-connection-action" type="button" disabled={Boolean(busy)} aria-label={`Edit ${connection.displayName}`} onClick={() => setEditor({ mode: "edit", connection })}><Pencil size={14} /></button> : null}
        {connection.removable ? <button className="settings-connection-action is-danger" type="button" disabled={Boolean(busy)} aria-label={`Delete ${connection.displayName}`} onClick={() => void remove(connection)}><Trash2 size={14} /></button> : null}
        <button className="plugin-switch" type="button" role="switch" aria-checked={connection.enabled} disabled={Boolean(busy)} aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.displayName}`} onClick={() => void toggle(connection)}><span /></button>
      </article>)}
      {!connections.length ? <p className="settings-empty">No connections configured.</p> : null}
    </div> : null}
    {editor ? <ConnectionEditor state={editor} saving={Boolean(busy)} onClose={() => setEditor(undefined)} onSave={save} /> : null}
  </section>;
}

function ConnectionEditor({ state, saving, onClose, onSave }: {
  state: EditorState;
  saving: boolean;
  onClose: () => void;
  onSave: (input: SaveConnectionRequest) => Promise<void>;
}) {
  const initial = state.connection;
  const [id, setId] = useState(initial?.id ?? "");
  const [type, setType] = useState<ConnectionTransport["type"]>(initial?.transport.type ?? "stdio");
  const [command, setCommand] = useState(initial?.transport.type === "stdio" ? initial.transport.command : "");
  const [args, setArgs] = useState(initial?.transport.type === "stdio" ? initial.transport.args.join("\n") : "");
  const [cwd, setCwd] = useState(initial?.transport.type === "stdio" ? initial.transport.cwd ?? "" : "");
  const [url, setUrl] = useState(initial?.transport.type === "http" ? initial.transport.url : "");
  const [advanced, setAdvanced] = useState(initial?.transport.type === "stdio" ? JSON.stringify(initial.transport.env ?? {}, null, 2) : JSON.stringify(initial?.transport.type === "http" ? initial.transport.headers ?? {} : {}, null, 2));
  const [formError, setFormError] = useState<string>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(undefined);
    try {
      const values = parseStringMap(advanced);
      const transport: ConnectionTransport = type === "stdio"
        ? { type, command: command.trim(), args: args.split("\n").map((value) => value.trim()).filter(Boolean), ...(Object.keys(values).length ? { env: values } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }
        : { type, url: url.trim(), ...(Object.keys(values).length ? { headers: values } : {}) };
      await onSave({ id: id.trim(), transport });
    } catch (cause) {
      setFormError(errorMessage(cause));
    }
  }

  return <div className="settings-connection-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="settings-connection-editor" onSubmit={(event) => void submit(event)}>
      <header><div><h3>{state.mode === "edit" ? "Edit connection" : "Add connection"}</h3><p>Configure a local command or remote MCP endpoint.</p></div><button type="button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <label><span>Connection ID</span><input required value={id} placeholder="context7" onChange={(event) => setId(event.target.value)} /></label>
      <div className="settings-connection-types" role="group" aria-label="Connection transport">
        <button className={type === "stdio" ? "is-active" : ""} type="button" onClick={() => setType("stdio")}>Local command</button>
        <button className={type === "http" ? "is-active" : ""} type="button" onClick={() => setType("http")}>HTTP</button>
      </div>
      {type === "stdio" ? <>
        <label><span>Command</span><input required value={command} placeholder="npx" onChange={(event) => setCommand(event.target.value)} /></label>
        <label><span>Arguments <small>One per line</small></span><textarea value={args} placeholder={"-y\n@package/mcp"} onChange={(event) => setArgs(event.target.value)} /></label>
        <label><span>Working directory <small>Optional</small></span><input value={cwd} placeholder="/path/to/project" onChange={(event) => setCwd(event.target.value)} /></label>
        <label><span>Environment variables <small>JSON</small></span><textarea value={advanced} onChange={(event) => setAdvanced(event.target.value)} /></label>
      </> : <>
        <label><span>URL</span><input required type="url" value={url} placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} /></label>
        <label><span>Headers <small>JSON</small></span><textarea value={advanced} onChange={(event) => setAdvanced(event.target.value)} /></label>
      </>}
      {formError ? <p className="settings-error" role="alert">{formError}</p> : null}
      <footer><button className="settings-secondary-button" type="button" onClick={onClose}>Cancel</button><button className="settings-primary-button" type="submit" disabled={saving}>{saving ? "Saving..." : "Save connection"}</button></footer>
    </form>
  </div>;
}

function parseStringMap(value: string): Record<string, string> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Object.values(parsed).every((item) => typeof item === "string")) throw new Error("Enter a JSON object containing string values");
  return parsed as Record<string, string>;
}

function connectionDefinition(connection: Connection): string {
  return connection.transport.type === "stdio"
    ? [connection.transport.command, ...connection.transport.args].join(" ")
    : connection.transport.url;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
