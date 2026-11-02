import { useRef, useState } from "react";
import type { AgentContextUsage } from "../shared/contracts.js";
import { AgentUsageDetails } from "./agent-usage.js";
import { Database, Gauge } from "./icons.js";
import { Popover } from "./ui/index.js";
import { t } from "./i18n.js";

/** Token counts the way people read them: 812, 11.2K, 1M. */
export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Under the chat's composer: how fast the latest response came, how much of
 * its prompt the provider's cache served, and how full the context is. The
 * ring opens the details, with a coding agent's quota where it reports one.
 */
export function ComposerStatus({ usage }: { usage?: AgentContextUsage }) {
  const ring = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Hovering the ring shows the details; they stay while the pointer moves onto them.
  const leaving = useRef(0);
  const hover = (next: boolean) => {
    window.clearTimeout(leaving.current);
    if (next) setOpen(true);
    else leaving.current = window.setTimeout(() => setOpen(false), 150);
  };
  const last = usage?.lastResponse;
  const percent = usage?.percent == null ? undefined : Math.max(0, Math.min(100, usage.percent));
  const limits = usage?.limits ?? [];
  if (!last && percent === undefined && !limits.length) return null;
  const shown = percent === undefined ? undefined : percent < 1 && percent > 0 ? "<1" : String(Math.round(percent));
  return (
    <div className="composer-status" role="status" aria-label={t("composerStatus.label")}>
      {last?.tokensPerSecond !== undefined ? (
        <span className="composer-status-item" title={t("composerStatus.speedHint")}>
          <Gauge size={13} aria-hidden="true" />{t("composerStatus.speed", { value: last.tokensPerSecond })}
        </span>
      ) : null}
      {last?.cacheHitPercent !== undefined ? (
        <span className="composer-status-item" title={t("composerStatus.cacheHint")}>
          <Database size={13} aria-hidden="true" />{t("composerStatus.cache", { percent: last.cacheHitPercent })}
        </span>
      ) : null}
      {percent !== undefined || limits.length ? (
        <button ref={ring} type="button" className="composer-status-item composer-status-context" aria-expanded={open}
          aria-label={percent === undefined ? t("agentUsage.title") : t("composerStatus.contextUsed", { percent: shown })}
          onClick={() => setOpen((value) => !value)} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
          <ContextRing percent={percent ?? 0} />
          {shown === undefined ? t("agentUsage.title") : `${shown}%`}
        </button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ring} placement="top" className="composer-status-popover" label={t("composerStatus.details")}>
        <div onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
          {percent !== undefined && usage ? <>
            <div className="composer-status-heading">
              <span>{t("composerStatus.contextUsed", { percent: shown })}</span>
              {usage.tokens !== null ? <span>~{formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}</span> : null}
            </div>
            <div className="composer-status-bar"><span style={{ width: `${percent}%` }} /></div>
            {last ? <p className="composer-status-note">{t("composerStatus.lastResponse", { tokens: formatTokens(last.outputTokens) })}</p> : null}
          </> : null}
          {limits.length ? <>
            <div className="composer-status-heading is-quota"><span>{t("agentUsage.title")}</span></div>
            <AgentUsageDetails limits={limits} />
          </> : null}
        </div>
      </Popover>
    </div>
  );
}

function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5, length = 2 * Math.PI * radius;
  return (
    <svg className="composer-status-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={radius} />
      <circle cx="7" cy="7" r={radius} strokeDasharray={`${(percent / 100) * length} ${length}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}
