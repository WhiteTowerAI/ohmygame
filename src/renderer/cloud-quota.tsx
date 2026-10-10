import type { CloudConnectionState, CloudQuota, QuotaBalance, QuotaUnit } from "../shared/cloud-models.js";

const units: Record<QuotaUnit, string> = { requests: "requests", tokens: "tokens", images: "images", models: "models", credits: "credits" };
const number = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
/** Hide another account's cached allowance while daemon synchronization finishes. */
export function accountCloudState(cloud: CloudConnectionState | undefined, userId: string | undefined): CloudConnectionState | undefined {
  if (!cloud) return undefined;
  if (!userId) return { availability: "sign_in_required" };
  if (cloud.availability === "sign_in_required") return cloud;
  if (cloud.userId !== userId) return { availability: "unavailable", message: "Checking account quota…" };
  return cloud;
}
export function cloudQuotaSummary(cloud?: CloudConnectionState): string {
  if (!cloud || cloud.availability === "sign_in_required") return "Sign in for free daily quota";
  if (cloud.availability === "unavailable") return cloud.message ?? "Temporarily unavailable";
  if (cloud.availability === "pool_exhausted") return "Shared daily quota exhausted";
  const quota = cloud.quota;
  if (!quota || quota.personal.remaining === null) return "Quota unavailable";
  const limit = quota.personal.limit === null ? "" : ` / ${number(quota.personal.limit)}`;
  return `${number(quota.personal.remaining)}${limit} ${units[quota.personal.unit ?? quota.unit]} left today`;
}
export function quotaResetTime(quota: CloudQuota): string {
  return formatResetTime(quota.availability === "pool_exhausted" ? quota.pool.resetsAt : quota.personal.resetsAt);
}
function formatResetTime(resetsAt: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(resetsAt));
}
function QuotaMeter({ balance, label }: { balance: QuotaBalance; label: string }) {
  if (balance.limit === null || balance.limit <= 0 || balance.remaining === null) return null;
  const remaining = Math.max(0, Math.min(balance.remaining, balance.limit));
  return <div className="cloud-quota-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={balance.limit} aria-valuenow={remaining}>
    <span style={{ width: `${remaining / balance.limit * 100}%` }} />
  </div>;
}
export function CloudQuotaDetails({ quota }: { quota: CloudQuota }) {
  const personalUnit = quota.personal.unit ?? quota.unit;
  return <div className="cloud-quota-details">
    {[{ label: personalUnit === "credits" ? "Your daily credits" : "Your daily quota", balance: quota.personal, unit: personalUnit },
      { label: "Shared pool", balance: quota.pool, unit: quota.pool.unit ?? quota.unit }].map(({ label, balance, unit }) => <div className="cloud-quota-row" key={label}>
      <div className="cloud-quota-row-heading"><span>{label}</span>
        <span>{number(balance.remaining)}{balance.limit !== null ? ` / ${number(balance.limit)}` : ""} {units[unit]}</span>
      </div>
      <QuotaMeter balance={balance} label={`${label} remaining`} />
    </div>)}
    <p className="cloud-quota-note">Resets {quotaResetTime(quota)}{quota.personal.reserved > 0 ? ` · ${number(quota.personal.reserved)} ${units[quota.personal.unit ?? quota.unit]} held` : ""}</p>
  </div>;
}
export function CloudQuotaStatus({ cloud, estimatedCredits, onSignIn }: { cloud: CloudConnectionState; estimatedCredits?: number; onSignIn: () => void }) {
  const quota = cloud.quota;
  return <div className="canvas-cloud-quota nodrag nopan">
    <div className="canvas-cloud-quota-summary"><span>{cloudQuotaSummary(cloud)}</span>
      {estimatedCredits !== undefined ? <span className="canvas-cloud-cost">{number(estimatedCredits)} credits / generation</span> : null}
      {cloud.availability === "sign_in_required" ? <button type="button" className="canvas-chip" onClick={onSignIn}>Sign in</button> : null}
    </div>
    {quota ? <><QuotaMeter balance={quota.personal} label="Your daily allowance remaining" />
      <div className="cloud-quota-note">Resets {quotaResetTime(quota)} · Shared {number(quota.pool.remaining)} {units[quota.pool.unit ?? quota.unit]}{quota.personal.reserved > 0 ? ` · ${number(quota.personal.reserved)} held` : ""}</div>
    </> : null}
  </div>;
}
