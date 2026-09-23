import { useMemo } from "react";
import type { StoryNode } from "../shared/contracts.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import "./story-settings.css";

type StorySettingsNode = Extract<StoryNode, { type: "settings" }>;

export function StorySettingsSurface({ node, accentColor, fullscreen = false, mode, onClose, onToggleFullscreen }: {
  node: StorySettingsNode;
  accentColor: string;
  fullscreen?: boolean;
  mode: "preview" | "runtime";
  onClose: () => void;
  onToggleFullscreen?: () => void;
}) {
  const title = node.data.title || "Settings";
  const content = useMemo(() => ({ title, accentColor, fullscreen, interactive: mode === "runtime" }), [accentColor, fullscreen, mode, title]);
  return <StoryScreenSurface
    files={node.data.presentation.surface.files}
    content={content}
    mode={mode}
    title={title}
    className="story-settings-surface"
    transparent={false}
    onAction={(action) => {
      if (action === "close") onClose();
      else if (action === "toggle-fullscreen") onToggleFullscreen?.();
    }}
  />;
}

export function StorySettings({ node, accentColor, fullscreen, onClose, onToggleFullscreen }: {
  node: StorySettingsNode;
  accentColor: string;
  fullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
}) {
  return <section className="story-settings" role="dialog" aria-modal="true" aria-label="Settings">
    <StorySettingsSurface node={node} accentColor={accentColor} fullscreen={fullscreen} mode="runtime" onClose={onClose} onToggleFullscreen={onToggleFullscreen} />
  </section>;
}
