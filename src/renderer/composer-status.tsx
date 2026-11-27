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
 * Beside the chat's send button: one ring for how full the context is, or the
 * quota when the context size is unknown. It opens the details: the context,
 * how fast the latest response came, how much of its prompt the provider's
 * cache served, and a coding agent's quota where it reports one.
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
  // Without a context size, the ring shows the fullest quota, or stays empty.
  const ringPercent = percent ?? Math.min(100, Math.max(0, ...limits.map((limit) => limit.usedPercent)));
  const shown = percent === undefined ? undefined : percent < 1 && percent > 0 ? "<1" : String(Math.round(percent));
  const speed = last?.tokensPerSecond;
  const cache = last?.cacheHitPercent;
  return (
    <span className="composer-status" role="status" aria-label={t("composerStatus.label")}>
      <button ref={ring} type="button" className="composer-status-context" aria-expanded={open}
        aria-label={percent !== undefined ? t("composerStatus.contextUsed", { percent: shown }) : limits.length ? t("agentUsage.title") : t("composerStatus.details")}
        onClick={() => setOpen((value) => !value)} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
        <ContextRing percent={ringPercent} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ring} placement="top" className="composer-status-popover" label={t("composerStatus.details")}>
        <div onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
          {percent !== undefined && usage ? <>
            <div className="composer-status-heading">
              <span>{t("composerStatus.contextUsed", { percent: shown })}</span>
              {usage.tokens !== null ? <span>~{formatTokens(usage.tokens)} / {formatTokens(usage.contextWindow)}</span> : null}
            </div>
            <div className="composer-status-bar"><span style={{ width: `${percent}%` }} /></div>
          </> : null}
          {last ? <>
            <p className="composer-status-note">{t("composerStatus.lastResponse", { tokens: formatTokens(last.outputTokens) })}</p>
            {speed !== undefined || cache !== undefined ? <div className="composer-status-metrics">
              {speed !== undefined ? (
                <span title={last.speedScope === "turn" ? t("composerStatus.speedHintTurn") : t("composerStatus.speedHint")}>
                  <Gauge size="sm" aria-hidden="true" />{t("composerStatus.speed", { value: speed })}
                </span>
              ) : null}
              {cache !== undefined ? (
                <span title={last.cacheScope === "turn" ? t("composerStatus.cacheHintTurn") : t("composerStatus.cacheHint")}>
                  <Database size="sm" aria-hidden="true" />{t("composerStatus.cache", { percent: cache })}
                </span>
              ) : null}
            </div> : null}
          </> : null}
          {limits.length ? <>
            <div className="composer-status-heading is-quota"><span>{t("agentUsage.title")}</span></div>
            <AgentUsageDetails limits={limits} />
          </> : null}
        </div>
      </Popover>
    </span>
  );
}

// A pie inside an outline rather than an arc, so it never reads as a loading spinner.
function ContextRing({ percent }: { percent: number }) {
  const radius = 2.5, length = 2 * Math.PI * radius;
  return (
    <svg className="composer-status-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="6" />
      <circle cx="7" cy="7" r={radius} strokeDasharray={`${(percent / 100) * length} ${length}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}
