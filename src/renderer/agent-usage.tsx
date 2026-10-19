import type { AgentUsageLimit } from "../shared/contracts.js";
import { t } from "./i18n.js";

/** Buckets that are the account's main quota; others, such as a model's own, are named. */
const MAIN_BUCKETS = new Set(["codex", "claude"]);

/** "5-hour", "Weekly": what a quota window covers, from its length. */
export function usageWindowLabel(limit: AgentUsageLimit): string {
  const minutes = limit.windowMinutes;
  const window =
    minutes === undefined || minutes <= 0
      ? t("agentUsage.window")
      : minutes === 7 * 24 * 60
        ? t("agentUsage.weekly")
        : minutes === 24 * 60
          ? t("agentUsage.daily")
          : minutes % (24 * 60) === 0
            ? t("agentUsage.days", { count: minutes / (24 * 60) })
            : minutes % 60 === 0
              ? t("agentUsage.hours", { count: minutes / 60 })
              : t("agentUsage.minutes", { count: minutes });
  const bucket = limit.id.split("/")[0] ?? "";
  return bucket && !MAIN_BUCKETS.has(bucket) ? `${bucket} · ${window}` : window;
}

/** A window whose reset time has passed was emptied; its last report is out of date. */
function wasReset(limit: AgentUsageLimit, now: number): boolean {
  return limit.resetsAt !== undefined && limit.resetsAt * 1000 <= now;
}

function current(limit: AgentUsageLimit, now: number): AgentUsageLimit {
  return wasReset(limit, now) ? { ...limit, usedPercent: 0 } : limit;
}

function level(percent: number): string {
  return percent >= 95 ? " is-danger" : percent >= 80 ? " is-warning" : "";
}

function Meter({ limit }: { limit: AgentUsageLimit }) {
  const percent = Math.round(limit.usedPercent);
  return (
    <span
      className={`cloud-quota-meter agent-usage-meter${level(percent)}`}
      role="meter"
      aria-label={usageWindowLabel(limit)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Quota windows in a row of the Agents list: a short label, a bar and the share used. */
export function AgentUsageInline({
  limits,
  now = Date.now(),
}: {
  limits: readonly AgentUsageLimit[];
  now?: number;
}) {
  return (
    <span className="agent-usage-inline">
      {limits.map((reported) => {
        const limit = current(reported, now);
        return (
          <span key={limit.id}>
            <small>{usageWindowLabel(limit)}</small>
            <Meter limit={limit} />
            <small>{Math.round(limit.usedPercent)}%</small>
          </span>
        );
      })}
    </span>
  );
}

/** Quota windows on an agent's detail page, with when each resets. */
export function AgentUsageDetails({
  limits,
  now = Date.now(),
}: {
  limits: readonly AgentUsageLimit[];
  now?: number;
}) {
  return (
    <div className="cloud-quota-details">
      {limits.map((reported) => {
        const limit = current(reported, now);
        return (
          <div className="cloud-quota-row" key={limit.id}>
            <div className="cloud-quota-row-heading">
              <span>{usageWindowLabel(limit)}</span>
              <span>
                {t("agentUsage.used", {
                  percent: Math.round(limit.usedPercent),
                })}
              </span>
            </div>
            <Meter limit={limit} />
            {limit.resetsAt !== undefined ? (
              <p className="cloud-quota-note">
                {wasReset(limit, now)
                  ? t("agentUsage.wasReset")
                  : t("agentUsage.resets", {
                      time: new Date(limit.resetsAt * 1000).toLocaleString(
                        undefined,
                        {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      ),
                    })}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
