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

/** The limit as it stands now: a window whose reset passed counts as empty. */
export function currentUsage(limit: AgentUsageLimit, now: number): AgentUsageLimit {
  return wasReset(limit, now) ? { ...limit, usedPercent: 0 } : limit;
}

/** "Resets in 2h 27m": how long until a window empties, to the minute. */
export function usageResetLabel(limit: AgentUsageLimit, now: number): string | undefined {
  if (limit.resetsAt === undefined) return undefined;
  if (wasReset(limit, now)) return t("agentUsage.wasReset");
  const minutes = Math.max(1, Math.ceil((limit.resetsAt * 1000 - now) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  const time = days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`;
  return t("agentUsage.resetsIn", { time });
}

/** " is-warning" near the limit and " is-danger" at it, for a meter's class. */
export function usageLevel(percent: number): string {
  return percent >= 95 ? " is-danger" : percent >= 80 ? " is-warning" : "";
}

function Meter({ limit }: { limit: AgentUsageLimit }) {
  const percent = Math.round(limit.usedPercent);
  return (
    <span
      className={`cloud-quota-meter agent-usage-meter${usageLevel(percent)}`}
      role="meter"
      aria-label={usageWindowLabel(limit)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={t("agentUsage.used", { percent })}
    >
      <span style={{ width: `${percent}%` }} />
    </span>
  );
}

/** Quota windows in a row of the Agents list: a short label, a bar and the share used. */
export function AgentUsageInline({
  limits,
  now = Date.now(),
  compact = false,
}: {
  limits: readonly AgentUsageLimit[];
  now?: number;
  /** Keep narrow menus numeric; the whole window explains the share used on hover. */
  compact?: boolean;
}) {
  return (
    <span className="agent-usage-inline">
      {limits.map((reported) => {
        const limit = currentUsage(reported, now);
        const window = usageWindowLabel(limit);
        const percent = Math.round(limit.usedPercent);
        const used = t("agentUsage.used", { percent });
        return (
          <span key={limit.id} title={compact ? [window, used, usageResetLabel(limit, now)].filter(Boolean).join(" · ") : undefined}>
            <small>{window}</small>
            <Meter limit={limit} />
            <small>{compact ? `${percent}%` : used}</small>
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
        const limit = currentUsage(reported, now);
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
