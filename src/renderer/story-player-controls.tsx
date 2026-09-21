import type { ReactNode } from "react";
import { Pause } from "./icons.js";

export function StoryPlayerControls({ pause, mode, onPause }: { pause: boolean; mode: "preview" | "runtime"; onPause?: () => void }) {
  if (!pause) return null;
  const icon = <Pause size={16} fill="currentColor" />;
  return <div className={`story-player-controls is-${mode}${onPause ? " is-interactive" : ""}`}>
    {onPause
      ? <button className="story-player-pause" type="button" title="Pause" aria-label="Pause" onClick={onPause}>{icon}</button>
      : <div className="story-player-pause" aria-hidden="true">{icon}</div>}
  </div>;
}

export function StoryPlayerPauseLayer({ children, modal = false }: { children: ReactNode; modal?: boolean }) {
  return <div className="story-player-pause-layer" role={modal ? "dialog" : "group"} aria-modal={modal || undefined} aria-label={modal ? "Game paused" : "Preview paused"}>
    <div>
      <span>Paused</span>
      {children}
    </div>
  </div>;
}
