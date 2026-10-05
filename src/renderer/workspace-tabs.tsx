import type { CSSProperties } from "react";
import type { IconComponent } from "./icons.js";

export interface WorkspaceTabOption<Id extends string> {
  id: Id;
  label: string;
  icon: IconComponent;
}

export function WorkspaceTabs<Id extends string>({ tabs, active, onChange, label = "Workspace views" }: {
  tabs: WorkspaceTabOption<Id>[];
  active: Id;
  onChange: (id: Id) => void;
  label?: string;
}) {
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === active));
  return <nav className="workspace-tabs" aria-label={label} style={{
    "--workspace-active-index": activeIndex,
    "--workspace-tab-columns": tabs.map((_, index) => index === activeIndex ? "var(--workspace-active-tab-width)" : "var(--workspace-tab-width)").join(" "),
  } as CSSProperties}>
    {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={`workspace-tab${id === active ? " workspace-tab-active" : ""}`} aria-pressed={id === active} title={label} onClick={() => { if (id !== active) onChange(id); }}>
      <Icon size={15} /><span>{label}</span>
    </button>)}
  </nav>;
}
