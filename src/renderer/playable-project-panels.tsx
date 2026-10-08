import { useEffect, useRef, type ReactNode } from "react";
import { Box, X } from "./icons.js";
import type { JsonObject } from "../shared/playable-nodes.js";
import { formatStateValue } from "../shared/playable-debug.js";
import { describePlayableValue } from "../shared/playable-editor.js";

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
 * The Variables (the graph's initialState), read-only: each one's name, the
 * Agent's description, and its starting value in author words. The Agent
 * adds and changes them; the starting-value tooltip includes the raw JSON value.
 */
export function PlayableVariablesPanel({ initialState, descriptions, onClose }: {
  initialState: JsonObject;
  descriptions?: Readonly<Record<string, string>>;
  onClose: () => void;
}) {
  const names = Object.keys(initialState);
  return <ProjectPanel label="Variables" icon={<Box size={14} />} onClose={onClose}>
    <p className="playable-project-panel-hint">What the game remembers from Scene to Scene and keeps in the save, such as a score or the items the player carries.</p>
    {names.length ? <ul className="playable-variables" aria-label="Variables">
      {names.map((name) => <li key={name}>
        <div className="playable-variables-head">
          <strong>{name}</strong>
          <span title={formatStateValue(initialState[name])}>Starts {describePlayableValue(initialState[name]!)}</span>
        </div>
        {descriptions?.[name] ? <p>{descriptions[name]}</p> : null}
      </li>)}
    </ul> : <p className="playable-variables-empty">Nothing yet. The game doesn't remember anything between Scenes.</p>}
    <p className="playable-project-panel-hint">Ask the AI to add or change them.</p>
  </ProjectPanel>;
}
