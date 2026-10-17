import type { CloudConnectionState, CloudQuota, QuotaBalance, QuotaUnit } from "../shared/cloud-models.js";
import { language, t } from "./i18n.js";

const units: Record<QuotaUnit, string> = { requests: t("quota.unit.requests"), tokens: t("quota.unit.tokens"), images: t("quota.unit.images"), models: t("quota.unit.models"), credits: t("quota.unit.credits") };
const number = (value: number | null) => value === null ? t("quota.unavailable") : value.toLocaleString(language, { maximumFractionDigits: 3 });
/** Hide another account's cached allowance while daemon synchronization finishes. */
export function accountCloudState(cloud: CloudConnectionState | undefined, userId: string | undefined): CloudConnectionState | undefined {
  if (!cloud) return undefined;
  if (!userId) return { availability: "sign_in_required" };
  if (cloud.availability === "sign_in_required") return cloud;
  if (cloud.userId !== userId) return { availability: "unavailable", message: t("quota.checking") };
  return cloud;
}
export function cloudQuotaSummary(cloud?: CloudConnectionState): string {
  if (!cloud || cloud.availability === "sign_in_required") return t("quota.signIn");
  if (cloud.availability === "unavailable") return cloud.message ?? t("quota.temporarilyUnavailable");
  const quota = cloud.quota;
  if (!quota || quota.personal.remaining === null) return t("quota.quotaUnavailable");
  const limit = quota.personal.limit === null ? "" : ` / ${number(quota.personal.limit)}`;
  return t("quota.leftToday", { amount: `${number(quota.personal.remaining)}${limit}`, unit: units[quota.unit] });
}
/** Provider readiness uses the cheapest model; the selected model may cost more. */
export function canAffordCloudModel(cloud: CloudConnectionState, estimatedCredits?: number): boolean {
  if (cloud.availability !== "ready") return false;
  if (estimatedCredits === undefined) return true;
  const quota = cloud.quota;
  if (!quota || quota.unit !== "credits" || quota.personal.remaining === null) return false;
  return quota.personal.remaining + Number.EPSILON * Math.max(1, quota.personal.limit ?? 1) >= estimatedCredits;
}
export function quotaResetTime(quota: CloudQuota): string {
  return new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(quota.personal.resetsAt));
}
function QuotaMeter({ balance, label }: { balance: QuotaBalance; label: string }) {
  if (balance.limit === null || balance.limit <= 0 || balance.remaining === null) return null;
  const remaining = Math.max(0, Math.min(balance.remaining, balance.limit));
  return <div className="cloud-quota-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={balance.limit} aria-valuenow={remaining}>
    <span style={{ width: `${remaining / balance.limit * 100}%` }} />
  </div>;
}
export function CloudQuotaDetails({ quota }: { quota: CloudQuota }) {
  const label = quota.unit === "credits" ? t("quota.dailyCredits") : t("quota.dailyQuota");
  const balance = quota.personal;
  return <div className="cloud-quota-details">
    <div className="cloud-quota-row">
      <div className="cloud-quota-row-heading"><span>{label}</span>
        <span>{number(balance.remaining)}{balance.limit !== null ? ` / ${number(balance.limit)}` : ""} {units[quota.unit]}</span>
      </div>
      <QuotaMeter balance={balance} label={t("quota.remaining", { label })} />
    </div>
    <p className="cloud-quota-note">{t("quota.resets", { time: quotaResetTime(quota) })}{balance.reserved > 0 ? t("quota.held", { amount: number(balance.reserved), unit: units[quota.unit] }) : ""}</p>
  </div>;
}
export function CloudQuotaStatus({ cloud, estimatedCredits, onSignIn }: { cloud: CloudConnectionState; estimatedCredits?: number; onSignIn: () => void }) {
  const quota = cloud.quota;
  return <div className="canvas-cloud-quota nodrag nopan">
    <div className="canvas-cloud-quota-summary"><span>{cloudQuotaSummary(cloud)}</span>
      {estimatedCredits !== undefined ? <span className="canvas-cloud-cost">{t("quota.perGeneration", { credits: number(estimatedCredits) })}</span> : null}
      {cloud.availability === "sign_in_required" ? <button type="button" className="canvas-chip" onClick={onSignIn}>{t("common.signIn")}</button> : null}
    </div>
    {cloud.availability === "ready" && !canAffordCloudModel(cloud, estimatedCredits) ? <div className="cloud-quota-note" role="status">{t("quota.notEnough")}</div> : null}
    {quota ? <><QuotaMeter balance={quota.personal} label={t("quota.allowanceRemaining")} />
      <div className="cloud-quota-note">{t("quota.resets", { time: quotaResetTime(quota) })}{quota.personal.reserved > 0 ? t("quota.held", { amount: number(quota.personal.reserved), unit: units[quota.unit] }) : ""}</div>
    </> : null}
  </div>;
}
