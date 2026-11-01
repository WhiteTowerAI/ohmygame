import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginComponentSummary } from "../shared/plugins.js";
import { readPluginSkill } from "./api.js";
import { t } from "./i18n.js";
import { ChevronRight, FolderOpen } from "./icons.js";
import { MarkdownContent } from "./markdown-content.js";
import { Alert, Button, IconButton, Spinner, Switch } from "./ui/index.js";

/** A SKILL.md's metadata, which the row above its content already shows. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??---[ \t]*(?:\r?\n|$)/;

/** A Skill on a plugin's page; `enabled` only where Skills switch one by one. */
export type SkillItem = Omit<PluginComponentSummary, "enabled"> & { enabled?: boolean };

/** The Skills of a plugin: each opens to show its content. */
export function SkillSection({ pluginId, items, installed, disabled, onBrowse, onToggle }: {
  pluginId: string;
  items: SkillItem[];
  installed: boolean;
  disabled?: boolean;
  onBrowse: (skillId: string) => void;
  /** Format 2 plugins have no switch per Skill; without this, none shows. */
  onToggle?: (component: PluginComponentSummary, enabled: boolean) => void;
}): ReactNode {
  const [expanded, setExpanded] = useState<{ id: string; phase: "loading" | "ready" | "error"; content?: string; error?: string }>();
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setExpanded(undefined);
  }, [pluginId]);

  async function loadContent(item: SkillItem): Promise<void> {
    const currentRequest = ++requestId.current;
    setExpanded({ id: item.id, phase: "loading" });
    try {
      const result = await readPluginSkill(pluginId, item.id);
      if (requestId.current === currentRequest) setExpanded({ id: item.id, phase: "ready", content: result.content });
    } catch (cause) {
      if (requestId.current === currentRequest) setExpanded({ id: item.id, phase: "error", error: errorMessage(cause) });
    }
  }

  function toggleContent(item: SkillItem): void {
    if (expanded?.id === item.id) {
      requestId.current += 1;
      setExpanded(undefined);
    } else {
      void loadContent(item);
    }
  }

  if (!items.length) return null;
  return <div className="plugin-skill-list">{items.map((item) => {
    const open = expanded?.id === item.id;
    return <div className={`plugin-skill${open ? " is-open" : ""}`} key={item.id}>
      <div className="plugin-skill-row">
        <button className="plugin-skill-open" type="button" aria-expanded={open} onClick={() => toggleContent(item)}>
          <ChevronRight size={14} className="plugin-skill-caret" aria-hidden="true" />
          <span className="plugin-skill-copy"><strong className="plugins-mono">{item.name}</strong>{item.description ? <span>{item.description}</span> : null}</span>
        </button>
        {installed && window.ohMyGameDesktop ? <IconButton size="sm" label={t("plugins.showNameInFinder", { name: item.name })} onClick={() => onBrowse(item.id)}><FolderOpen size={14} /></IconButton> : null}
        {installed && onToggle ? <Switch size="sm" checked={item.enabled !== false} disabled={disabled} label={item.enabled !== false ? t("plugins.disableName", { name: item.name }) : t("plugins.enableName", { name: item.name })} onChange={enabled => onToggle({ ...item, enabled: item.enabled !== false }, enabled)} /> : null}
      </div>
      {open ? <div className="plugin-skill-content">
        {expanded.phase === "loading" ? <div className="plugins-state"><Spinner size={14} label={t("plugins.loadingSkill")} />{t("plugins.loadingSkill")}</div> : null}
        {expanded.phase === "error" ? <Alert tone="danger" title={expanded.error} action={<Button size="sm" onClick={() => void loadContent(item)}>{t("common.retry")}</Button>} /> : null}
        {expanded.phase === "ready" ? <MarkdownContent text={(expanded.content ?? "").replace(FRONTMATTER, "")} /> : null}
      </div> : null}
    </div>;
  })}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
