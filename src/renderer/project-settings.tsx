import { useId, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import type { ProjectState } from "../shared/contracts.js";
import { t } from "./i18n.js";
import { X } from "./icons.js";
import { ProjectGeneralSettings } from "./project-appearance-settings.js";
import { IconButton, Tabs, useModal } from "./ui/index.js";

export type ProjectSettingsTab = "general" | "workspace" | "plugins";

/** Where a workspace shows its own tab, while the project's settings are open. */
export interface ProjectSettingsSlot {
  node: HTMLElement;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}

/**
 * A project's settings, from the top bar, for every project type: General and
 * Plugins, with a tab of the workspace's own between them where it has one.
 * The tabs stay mounted, so an unsaved form survives moving between them.
 */
export function ProjectSettings({ project, initialTab, workspaceTab, workspaceRef, busy, plugins, onRename, onClose }: {
  project: ProjectState;
  initialTab: ProjectSettingsTab;
  /** The name of the workspace's tab; without one, it has none. */
  workspaceTab?: string;
  /** The tab's body, which the workspace renders into. */
  workspaceRef: Ref<HTMLDivElement>;
  /** The workspace's tab is saving, so the settings stay open. */
  busy: boolean;
  plugins: ReactNode;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [chosen, setTab] = useState(initialTab);
  // A workspace can lose its tab while the settings are open, when its project changes.
  const tab = chosen === "workspace" && !workspaceTab ? "general" : chosen;
  const close = () => { if (!busy) onClose(); };
  const panel = useModal(true, close);
  return createPortal(
    <div className="ui-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={panel} className="ui-dialog ui-dialog-md project-settings" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="ui-dialog-head">
          <h2 id={titleId} className="ui-dialog-title">{t("projectSettings.title")}</h2>
          <IconButton size="sm" label={t("common.close")} className="ui-dialog-close" disabled={busy} onClick={close}><X size={16} /></IconButton>
        </div>
        <div className="project-settings-tabs">
          <Tabs<ProjectSettingsTab> label={t("projectSettings.title")} value={tab} onChange={setTab} tabs={[
            { value: "general", label: t("projectSettings.tab.general") },
            ...(workspaceTab ? [{ value: "workspace" as const, label: workspaceTab }] : []),
            { value: "plugins", label: t("projectSettings.tab.plugins") },
          ]} />
        </div>
        <div className="project-settings-tab ui-dialog-body" hidden={tab !== "general"}><ProjectGeneralSettings project={project} onRename={onRename} /></div>
        {workspaceTab ? <div className="project-settings-tab" ref={workspaceRef} hidden={tab !== "workspace"} /> : null}
        <div className="project-settings-tab ui-dialog-body" hidden={tab !== "plugins"}>{plugins}</div>
      </div>
    </div>,
    document.body,
  );
}
