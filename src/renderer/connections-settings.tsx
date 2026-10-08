import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
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
    } finally {
      setBusy(undefined);
    }
  }

  return <section className="settings-panel settings-overview-panel">
    <header className="settings-panel-header">
      <h3>Connections</h3>
      <button className="settings-add-button" type="button" onClick={() => setEditor({ mode: "create" })}><Plus size={13} />Add connection</button>
    </header>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {phase === "loading" ? <div className="settings-loading"><LoaderCircle className="spin" size={15} />Loading connections</div> : null}
    {phase === "error" ? <button className="settings-secondary-button" type="button" onClick={() => void load()}>Retry</button> : null}
    {phase === "ready" ? <div className="settings-connection-list">
      {connections.map((connection) => <article className={`settings-connection-row${connection.enabled ? "" : " is-disabled"}`} key={connection.id}>
        <span className="settings-connection-icon">{connection.id === "ohmygame-godot" ? <GodotIcon size={20} /> : <Plug size={17} />}</span>
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
  const initialLocal = initial?.transport.type === "stdio" ? initial.transport : undefined;
  const initialHttp = initial?.transport.type === "http" ? initial.transport : undefined;
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const idInput = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  const savingRef = useRef(saving);
  const [id, setId] = useState(initial?.id ?? "");
  const [type, setType] = useState<ConnectionTransport["type"]>(initial?.transport.type ?? "stdio");
  const [command, setCommand] = useState(initialLocal?.command ?? "");
  const [args, setArgs] = useState(initialLocal?.args.join("\n") ?? "");
  const [cwd, setCwd] = useState(initialLocal?.cwd ?? "");
  const [url, setUrl] = useState(initialHttp?.url ?? "");
  const [env, setEnv] = useState(initialLocal?.env ? JSON.stringify(initialLocal.env, null, 2) : "");
  const [headers, setHeaders] = useState(initialHttp?.headers ? JSON.stringify(initialHttp.headers, null, 2) : "");
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(cwd.trim() || Object.keys(initialLocal?.env ?? initialHttp?.headers ?? {}).length));
  const [formError, setFormError] = useState<string>();
  closeRef.current = onClose;
  savingRef.current = saving;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    idInput.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!savingRef.current) closeRef.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const elements = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary")].filter((element) => element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.current.focus(); return; }
      if (!dialog.current.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => { window.removeEventListener("keydown", keyboard, true); previousFocus?.focus(); };
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setFormError(undefined);
    try {
      const values = parseStringMap(type === "stdio" ? env : headers);
      const transport: ConnectionTransport = type === "stdio"
        ? { type, command: command.trim(), args: args.split("\n").map((value) => value.trim()).filter(Boolean), ...(Object.keys(values).length ? { env: values } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }
        : { type, url: url.trim(), ...(Object.keys(values).length ? { headers: values } : {}) };
      await onSave({ id: id.trim(), transport });
    } catch (cause) {
      setFormError(errorMessage(cause));
    }
  }

  return createPortal(<div className="project-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section ref={dialog} className="project-settings-dialog connection-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{state.mode === "edit" ? "Edit connection" : "Add connection"}</h2><button type="button" disabled={saving} aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="connection-dialog-body">
          <fieldset className="project-settings-section" disabled={saving}>
            <div className="project-settings-field-row">
              <label><span>Connection ID</span><input ref={idInput} required value={id} placeholder="context7" onChange={(event) => setId(event.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label><span>Type</span><select value={type} onChange={(event) => { setType(event.target.value as ConnectionTransport["type"]); setFormError(undefined); }}><option value="stdio">Local command</option><option value="http">HTTP</option></select></label>
            </div>
            {type === "stdio" ? <>
              <label><span>Command</span><input required value={command} placeholder="npx" onChange={(event) => setCommand(event.target.value)} autoComplete="off" spellCheck={false} /></label>
              <label><span>Arguments <small>One per line</small></span><textarea rows={2} value={args} placeholder={"-y\n@package/mcp"} onChange={(event) => setArgs(event.target.value)} autoComplete="off" spellCheck={false} /></label>
            </> : <label><span>URL</span><input required type="url" value={url} placeholder="https://example.com/mcp" onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
            <details className="connection-dialog-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary>Advanced</summary>
              <div className="project-settings-section">
                {type === "stdio" ? <>
                  <label><span>Working directory <small>Optional</small></span><input value={cwd} placeholder="/path/to/project" onChange={(event) => setCwd(event.target.value)} autoComplete="off" spellCheck={false} /></label>
                  <label><span>Environment variables <small>JSON</small></span><textarea rows={3} value={env} placeholder={'{ "TOKEN": "value" }'} onChange={(event) => setEnv(event.target.value)} autoComplete="off" spellCheck={false} /></label>
                </> : <label><span>Headers <small>JSON</small></span><textarea rows={3} value={headers} placeholder={'{ "Authorization": "Bearer token" }'} onChange={(event) => setHeaders(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
              </div>
            </details>
          </fieldset>
          {formError ? <p className="project-settings-error" role="alert">{formError}</p> : null}
        </div>
        <footer><button type="button" disabled={saving} onClick={onClose}>Cancel</button><button className="project-settings-submit" type="submit" disabled={saving || !id.trim() || !(type === "stdio" ? command.trim() : url.trim())}>{saving ? <LoaderCircle className="spin" size={14} /> : null}{saving ? "Saving…" : state.mode === "edit" ? "Save changes" : "Add connection"}</button></footer>
      </form>
    </section>
  </div>, document.body);
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
