import type { ReactNode } from "react";
import type { StorePlugin } from "../shared/plugins.js";
import { t } from "./i18n.js";
import { hookLabel } from "./plugin-hook-labels.js";
import "./plugins.css";

/** The top of a plugin's page, for an installed plugin and for a draft alike. */
export function PluginHead({ tile, title, badges, description, children }: {
  tile: ReactNode;
  title: string;
  badges?: ReactNode;
  description: string;
  /** Actions at the end of the head. */
  children?: ReactNode;
}) {
  return <header className="plugin-head">
    {tile}
    <div className="plugin-head-copy">
      <h1><span>{title}</span>{badges}</h1>
      <p>{description}</p>
    </div>
    {children}
  </header>;
}

export interface PluginAddRow { id: string; kind: string; title: ReactNode }

/** What a plugin adds, as rows of kind and title. */
export function pluginAddRows(adds: StorePlugin["adds"]): PluginAddRow[] {
  const rows = [
    ...adds.projectTypes.map((title) => ({ kind: t("pluginStore.addsType"), title })),
    ...adds.panels.map((title) => ({ kind: t("pluginStore.addsPanel"), title })),
    ...adds.commands.map((title) => ({ kind: t("pluginStore.addsCommand"), title })),
    ...adds.mcpServers.map((title) => ({ kind: t("pluginStore.addsMcpServer"), title })),
    ...(adds.instructions ? [{ kind: t("pluginStore.addsInstructions"), title: <div className="plugin-instructions">{adds.instructions}</div> }] : []),
    ...(adds.hooks ?? []).map((hook) => ({ kind: t("pluginStore.addsHook"), title: hookLabel(hook) })),
    ...adds.modelProviders.map((title) => ({ kind: t("pluginStore.addsModelProvider"), title })),
    ...adds.agents.map((title) => ({ kind: t("pluginStore.addsAgent"), title })),
    ...adds.skills ? [{ kind: t("plugins.skills"), title: t("plugins.skillCount", { count: adds.skills }) }] : [],
    ...adds.tools ? [{ kind: t("pluginStore.tools"), title: t("pluginStore.toolCount", { count: adds.tools }) }] : [],
  ];
  return rows.map((row) => ({ ...row, id: `${row.kind}:${row.title}` }));
}

export function PluginAddsList({ rows }: { rows: readonly PluginAddRow[] }) {
  return <ul className="plugin-store-adds">
    {rows.map((row) => <li key={row.id}><span>{row.kind}</span>{row.title}</li>)}
  </ul>;
}
