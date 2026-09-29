import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Plus, Trash2, X } from "./icons.js";
import type { JsonObject, JsonValue } from "../shared/playable-nodes.js";
import type { PlayableStateChange } from "../shared/playable-debug.js";
import { formatStateValue } from "../shared/playable-debug.js";
import { parsePreviewStateInput, playableStateType, type PlayableStateType } from "../shared/playable-editor.js";
import { useTechnicalDetails } from "./playable-details.js";
import { PreviewStateRow } from "./playable-node-workbench.js";

const STATE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$.-]*$/;
const RECENT_CHANGES = 8;
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
  /** Whose preview the values come from, such as a Scene title. */
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
 * The Variables (the graph's initialState): each one's starting value, its
 * inferred type in technical mode, and its value now while a preview runs.
 */
export function PlayableStatePanel({ initialState, live, onChange, onClose }: {
  initialState: JsonObject;
  live?: PlayableLiveState;
  onChange: (initialState: JsonObject) => void;
  onClose: () => void;
}) {
  const technical = useTechnicalDetails();
  const keys = Object.keys(initialState);
  const recent = live ? live.changes.slice(-RECENT_CHANGES).reverse() : [];
  const changedKeys = new Set(recent.map((change) => change.key));
  return <ProjectPanel label="Variables" icon={<Box size={14} />} onClose={onClose}>
    <p className="playable-project-panel-hint">
      What the game remembers, such as a score or an item the player found. Every Scene can read and change them; the AI adds one when a Scene needs it.
      {live ? <> "Now" shows the <b>{live.source}</b> preview.</> : " Open a Scene to see their values now."}
    </p>
    {keys.length ? <div className={`playable-state-table${live ? " has-live" : ""}${technical ? " has-type" : ""}`} role="table" aria-label="Variables">
      <div className="playable-state-table-head" role="row">
        <span role="columnheader">Name</span>
        {technical ? <span role="columnheader">Type</span> : null}
        <span role="columnheader">Starts at</span>
        {live ? <span role="columnheader">Now</span> : null}
        <span aria-hidden="true" />
      </div>
      {keys.map((key) => {
        const initial = initialState[key]!;
        const liveValue = live?.state[key];
        return <div className={`playable-state-table-row${changedKeys.has(key) ? " is-changed" : ""}`} role="row" key={key}>
          <code role="cell" title={key}>{key}</code>
          {technical ? <span role="cell" className="playable-state-type">{playableStateType(initial)}</span> : null}
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
          <button type="button" title="Remove variable" aria-label={`Remove variable ${key}`} onClick={() => {
            const next = { ...initialState };
            delete next[key];
            onChange(next);
          }}><Trash2 size={12} /></button>
        </div>;
      })}
    </div> : <p className="story-media-empty">The game has no Variables yet.</p>}
    <NewStateKey taken={keys} onAdd={(key, value) => onChange({ ...initialState, [key]: value })} />
    {live ? <section className="playable-state-changes" aria-label="Recent changes">
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
    <input aria-label="New variable name" placeholder="New variable" value={key} maxLength={64} spellCheck={false} onChange={(event) => setKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
    <select aria-label="Kind of new variable" value={type} onChange={(event) => {
      const next = event.target.value as keyof typeof NEW_KEY_DEFAULTS;
      setType(next);
      setValue(typeof NEW_KEY_DEFAULTS[next] === "string" ? "" : JSON.stringify(NEW_KEY_DEFAULTS[next]));
    }}>
      {Object.keys(NEW_KEY_DEFAULTS).map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
    {type === "boolean"
      ? <select aria-label="Starting value of new variable" value={value} onChange={(event) => setValue(event.target.value)}><option value="false">false</option><option value="true">true</option></select>
      : <input aria-label="Starting value of new variable" value={value} spellCheck={false} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />}
    <button type="button" title="Add variable" aria-label="Add variable" disabled={!key.trim()} onClick={add}><Plus size={12} /></button>
    {error ? <p className="story-media-error" role="alert">{error}</p> : null}
  </div>;
}
