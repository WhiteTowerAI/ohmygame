import type { ReactNode } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { ChevronDown } from "./icons.js";
import { DropdownMenu, type MenuEntry } from "./ui/index.js";
import { t } from "./i18n.js";
import "./project-frame.css";

/**
 * The project workspace: the project rail, a project top bar, and the body.
 * The frame owns no state; the rail and the bar come from the project. The
 * rail is the collapsed sidebar, so it takes the sidebar's collapsed styles.
 */
export function ProjectFrame({ rail, top, children }: { rail: ReactNode; top: ReactNode; children: ReactNode }) {
  return (
    <div className="project-frame is-sidebar-collapsed">
      {rail}
      <header className="project-top">{top}</header>
      <div className="project-body">{children}</div>
    </div>
  );
}

/**
 * The project top bar: the project's name as its menu (the rail shows only
 * its cover), a status only when it needs attention, then the project's
 * actions on the right.
 */
export function ProjectTop({ name, icon, menu, status, children }: { name: string; icon?: ReactNode; menu: readonly MenuEntry[]; status?: ReactNode; children?: ReactNode }) {
  return (
    <>
      <DropdownMenu placement="bottom-start" items={menu} trigger={(props) => (
        <button type="button" {...props} className="project-name" title={name}>
          {icon}<span>{name}</span><ChevronDown size={12} />
        </button>
      )} />
      {status ? <span className="project-status" role="status">{status}</span> : null}
      <span className="project-top-spacer" />
      {children}
    </>
  );
}

/**
 * The top bar's Publish button. The app publishes games that play as a web
 * page (`builtIn`); plugins add their own ways (`plugins` of them). An asset
 * canvas with none has nothing to publish, and Godot and plugin projects with
 * none can't publish yet. It waits while the agent works.
 */
export function publishAction(project: Pick<ProjectState, "type" | "pluginType">, { publishing, agentBusy, plugins = 0 }: { publishing: boolean; agentBusy: boolean; plugins?: number }): { disabled: boolean; label: string; builtIn: boolean } | undefined {
  const builtIn = project.type !== "asset-canvas" && project.type !== "godot-game" && project.pluginType?.preview !== "native";
  if (project.type === "asset-canvas" && !plugins) return undefined;
  return {
    disabled: (!builtIn && !plugins) || publishing || agentBusy,
    label: project.type === "godot-game" && !plugins ? t("workspace.godotPublishing") : publishing ? t("workspace.publishing") : t("workspace.publish"),
    builtIn,
  };
}
