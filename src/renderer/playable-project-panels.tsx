import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, FileCode2, Palette, Plus, Trash2, X } from "./icons.js";
import type { JsonObject, JsonValue } from "../shared/playable-nodes.js";
import type { PlayableStateChange } from "../shared/playable-debug.js";
import { formatStateValue } from "../shared/playable-debug.js";
import { parsePreviewStateInput, playableStateType, type PlayableStateType } from "../shared/playable-editor.js";
import { getWorkspaceFile } from "./api.js";
import { PreviewStateRow } from "./playable-node-workbench.js";

const STATE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const RECENT_CHANGES = 8;
const STYLE_FILES = [
  { path: "shared/style/theme.css", label: "Tokens", detail: "Colors, type, spacing" },
  { path: "shared/style/components.css", label: "Components", detail: "Shared classes" },
  { path: "shared/style/components.js", label: "Scripts", detail: "Shared behaviour, such as cinematics" },
] as const;
const NEW_KEY_DEFAULTS: Record<Exclude<PlayableStateType, "null">, JsonValue> = {
  text: "",
  number: 0,
  boolean: false,
  list: [],
  object: {},
};

/** Live values from the preview open in a Workbench. */
export interface PlayableLiveState {
  state: JsonObject;
  changes: readonly PlayableStateChange[];
  /** Whose preview the values come from, such as a Node title. */
  source: string;
}

function ProjectPanel({ label, icon, onClose, children }: {
  label: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnKey);
    root.current?.focus();
    return () => window.removeEventListener("keydown", closeOnKey);
  }, [onClose]);
  return <aside ref={root} className="playable-project-panel" aria-label={label} tabIndex={-1}>
    <header>
      {icon}
      <strong>{label}</strong>
      <button type="button" title="Close" aria-label={`Close ${label}`} onClick={onClose}><X size={13} /></button>
    </header>
    <div className="playable-project-panel-body">{children}</div>
  </aside>;
}

/**
 * The project's shared data: every key with its initial value and inferred
 * type, and the live value while a Workbench preview runs.
 */
export function PlayableStatePanel({ initialState, live, onChange, onClose }: {
  initialState: JsonObject;
  live?: PlayableLiveState;
  onChange: (initialState: JsonObject) => void;
  onClose: () => void;
}) {
  const keys = Object.keys(initialState);
  const recent = live ? live.changes.slice(-RECENT_CHANGES).reverse() : [];
  const changedKeys = new Set(recent.map((change) => change.key));
  return <ProjectPanel label="Project State" icon={<Box size={14} />} onClose={onClose}>
    <p className="playable-project-panel-hint">
      Every Node reads and writes these keys. The Agent adds a key when a Node needs one.
      {live ? <> Live values come from the <b>{live.source}</b> preview.</> : " Open a Node to see live values."}
    </p>
    {keys.length ? <div className={`playable-state-table${live ? " has-live" : ""}`} role="table" aria-label="Project State">
      <div className="playable-state-table-head" role="row">
        <span role="columnheader">Key</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Initial</span>
        {live ? <span role="columnheader">Live</span> : null}
        <span aria-hidden="true" />
      </div>
      {keys.map((key) => {
        const initial = initialState[key]!;
        const liveValue = live?.state[key];
        return <div className={`playable-state-table-row${changedKeys.has(key) ? " is-changed" : ""}`} role="row" key={key}>
          <code role="cell" title={key}>{key}</code>
          <span role="cell" className="playable-state-type">{playableStateType(initial)}</span>
          <div role="cell" className="playable-state-initial">
            {initial === null
              ? <span className="playable-state-null">null</span>
              : <PreviewStateRow
                  name={key}
                  initial={initial}
                  value={initial}
                  overridden={false}
                  onChange={(value) => onChange({ ...initialState, [key]: value })}
                />}
          </div>
          {live ? <span role="cell" className="playable-state-live" title={formatStateValue(liveValue)}>{formatStateValue(liveValue)}</span> : null}
          <button type="button" title="Remove key" aria-label={`Remove State key ${key}`} onClick={() => {
            const next = { ...initialState };
            delete next[key];
            onChange(next);
          }}><Trash2 size={12} /></button>
        </div>;
      })}
    </div> : <p className="story-media-empty">The project declares no State yet.</p>}
    <NewStateKey taken={keys} onAdd={(key, value) => onChange({ ...initialState, [key]: value })} />
    {live ? <section className="playable-state-changes" aria-label="Recent State changes">
      <h3>Recent changes</h3>
      {recent.length ? <ol>
        {recent.map((change, index) => <li key={`${change.at}:${change.key}:${index}`}>
          <code>{change.key}</code>
          <span>{formatStateValue(change.before)} → {formatStateValue(change.after)}</span>
        </li>)}
      </ol> : <p className="story-media-empty">No changes in this preview yet.</p>}
    </section> : null}
  </ProjectPanel>;
}

function NewStateKey({ taken, onAdd }: { taken: readonly string[]; onAdd: (key: string, value: JsonValue) => void }) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<keyof typeof NEW_KEY_DEFAULTS>("number");
  const [value, setValue] = useState("0");
  const [error, setError] = useState<string>();
  const add = () => {
    const name = key.trim();
    if (!STATE_KEY_PATTERN.test(name)) return setError("Start with a letter; use letters, digits, _ . -");
    if (taken.includes(name)) return setError(`"${name}" already exists.`);
    const parsed = parsePreviewStateInput(value, NEW_KEY_DEFAULTS[type]);
    if ("error" in parsed) return setError(parsed.error);
    setError(undefined);
    onAdd(name, parsed.value);
    setKey("");
  };
  return <div className="playable-state-new">
    <input aria-label="New State key" placeholder="New key" value={key} maxLength={64} spellCheck={false} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
    <select aria-label="Type of new key" value={type} onChange={(event) => {
      const next = event.target.value as keyof typeof NEW_KEY_DEFAULTS;
      setType(next);
      setValue(typeof NEW_KEY_DEFAULTS[next] === "string" ? "" : JSON.stringify(NEW_KEY_DEFAULTS[next]));
    }}>
      {Object.keys(NEW_KEY_DEFAULTS).map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
    {type === "boolean"
      ? <select aria-label="Initial value of new key" value={value} onChange={(event) => setValue(event.target.value)}><option value="false">false</option><option value="true">true</option></select>
      : <input aria-label="Initial value of new key" value={value} spellCheck={false} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />}
    <button type="button" title="Add key" aria-label="Add State key" disabled={!key.trim()} onClick={add}><Plus size={12} /></button>
    {error ? <p className="story-media-error" role="alert">{error}</p> : null}
  </div>;
}

interface StyleToken {
  name: string;
  value: string;
}

/**
 * The Project Style: the tokens every Node shares, and the files that hold
 * them. Restyling happens in conversation or in those files.
 */
export function PlayableStylePanel({ projectId, revision, onOpenFile, onClose }: {
  projectId: string;
  revision: number;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [tokens, setTokens] = useState<StyleToken[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void getWorkspaceFile(projectId, STYLE_FILES[0].path).then((file) => {
      if (disposed) return;
      setTokens(styleTokens(file.content ?? ""));
      setError(undefined);
    }).catch(() => {
      if (!disposed) setError(`${STYLE_FILES[0].path} is missing.`);
    });
    return () => { disposed = true; };
  }, [projectId, revision]);

  const colors = tokens?.filter((token) => token.name.startsWith("--color-")) ?? [];
  const others = tokens?.filter((token) => !token.name.startsWith("--color-")) ?? [];
  return <ProjectPanel label="Project Style" icon={<Palette size={14} />} onClose={onClose}>
    <p className="playable-project-panel-hint">
      Every Node imports the Project Style, so changing it restyles the whole game. Ask the Agent, for example "make the game warmer, like lamp light on old paper".
    </p>
    {error ? <p className="story-media-error" role="alert">{error}</p> : null}
    {colors.length ? <section className="playable-style-colors" aria-label="Colors">
      <h3>Colors</h3>
      <div>
        {colors.map((token) => <span key={token.name} title={`${token.name}: ${token.value}`}>
          <i style={{ background: token.value }} />
          <code>{token.name.slice("--color-".length)}</code>
        </span>)}
      </div>
    </section> : null}
    {others.length ? <section className="playable-style-tokens" aria-label="Tokens">
      <h3>Tokens</h3>
      <dl>
        {others.map((token) => <div key={token.name}>
          <dt><code>{token.name}</code></dt>
          <dd title={token.value} style={token.name.startsWith("--font-") && !token.value.includes("var(") ? { fontFamily: token.value } : undefined}>{token.value}</dd>
        </div>)}
      </dl>
    </section> : null}
    <section className="playable-style-files" aria-label="Style files">
      <h3>Files</h3>
      {STYLE_FILES.map((file) => <button type="button" key={file.path} onClick={() => onOpenFile(file.path)}>
        <FileCode2 size={14} />
        <span><strong>{file.label}</strong><small>{file.path} · {file.detail}</small></span>
      </button>)}
    </section>
  </ProjectPanel>;
}

/** Custom property declarations of a stylesheet, in source order. */
export function styleTokens(css: string): StyleToken[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/g)]
    .map((match) => ({ name: match[1]!, value: match[2]!.trim() }));
}
