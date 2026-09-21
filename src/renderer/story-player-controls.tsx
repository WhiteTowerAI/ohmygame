import type { ReactNode } from "react";
import { Pause } from "./icons.js";

export function StoryPlayerControls({ onPause }: { onPause: () => void }) {
  return <div className="story-player-controls">
    <button className="story-player-pause" type="button" title="Pause" aria-label="Pause" onClick={onPause}><Pause size={16} /></button>
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
