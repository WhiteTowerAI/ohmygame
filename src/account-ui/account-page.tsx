import { useEffect, useState } from "react";
import { AltArrowLeftIcon } from "@solar-icons/react/linear/alt-arrow-left";
import { AltArrowRightIcon } from "@solar-icons/react/linear/alt-arrow-right";
import { RefreshIcon } from "@solar-icons/react/linear/refresh";
import {
  type AccountApi,
  type AccountPlan,
  type AccountSubscription,
  type AccountUsage,
  paymentUrl,
} from "../shared/account.js";
import "./styles.css";

export type AccountSection = "plans" | "usage" | "billing";

interface AccountPageProps {
  section: AccountSection;
  api: AccountApi;
  userId?: string;
  loadingAuth?: boolean;
  requestToken: () => Promise<string | undefined>;
  onSignIn: () => void;
  openPayment: (url: string) => Promise<void>;
}

export function AccountPage({
  section,
  api,
  userId,
  loadingAuth = false,
  requestToken,
  onSignIn,
  openPayment,
}: AccountPageProps) {
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [plans, setPlans] = useState<AccountPlan[]>();
  const [subscription, setSubscription] = useState<AccountSubscription>();
  const [usage, setUsage] = useState<AccountUsage>();
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [pending, setPending] = useState<string>();

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    setPage(1);
  }, [userId, section]);

  useEffect(() => {
    if (section !== "plans") return;
    let active = true;
    setPlans(undefined);
    setError(undefined);
    setActionError(undefined);
    void api.plans()
      .then((result) => {
        if (active) setPlans(result);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [api, section, revision]);

  useEffect(() => {
    if (section === "plans") return;
    let active = true;
    setSubscription(undefined);
    setUsage(undefined);
    setError(undefined);
    setActionError(undefined);
    if (loadingAuth || !userId) return;

    void (async () => {
      const token = await requestToken();
      if (!token) throw new Error("Sign in to view your account.");
      if (section === "usage") {
        const result = await api.usage(token, page);
        if (active) setUsage(result);
        return;
      }
      const result = await api.subscription(token);
      if (active) setSubscription(result);
    })().catch((cause) => {
      if (active) setError(errorMessage(cause));
    });

    return () => {
      active = false;
    };
  }, [api, userId, loadingAuth, section, page, revision, requestToken]);

  async function openAccountPayment(planId?: number) {
    setPending(planId ? String(planId) : "manage");
    setActionError(undefined);
    try {
      const token = await requestToken();
      if (!token) {
        onSignIn();
        return;
      }
      const result = planId
        ? await api.checkout(token, planId)
        : await api.manage(token);
      await openPayment(paymentUrl(result.url));
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setPending(undefined);
    }
  }

  let content;
  if (error) {
    content = (
      <div role="alert" className="og-account-state">
        <p>{error}</p>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button>
      </div>
    );
  } else if (section !== "plans" && loadingAuth) {
    content = <Loading />;
  } else if (section !== "plans" && !userId) {
    content = (
      <div className="og-account-state">
        <p>Sign in to view your {section}.</p>
        <button type="button" onClick={onSignIn}>Sign in</button>
      </div>
    );
  } else if (section === "plans") {
    content = plans ? (
      <PlansPanel
        plans={plans}
        pending={pending}
        onChoose={(planId) => userId ? void openAccountPayment(planId) : onSignIn()}
      />
    ) : <Loading />;
  } else if (section === "billing") {
    content = subscription ? (
      <BillingPanel
        subscription={subscription}
        pending={Boolean(pending)}
        onManage={() => void openAccountPayment()}
      />
    ) : <Loading />;
  } else {
    content = usage ? <UsagePanel usage={usage} onPageChange={setPage} /> : <Loading />;
  }

  const title = section === "plans" ? "Plans" : section === "usage" ? "Usage" : "Billing";
  return (
    <div className="og-account">
      <header className="og-account-heading">
        <h1>{title}</h1>
        <button
          type="button"
          title="Refresh account"
          aria-label="Refresh account"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshIcon size={18} />
        </button>
      </header>
      {section === "usage" ? (
        <p className="og-account-muted">OpenGame usage in the last 30 days. External providers are not included.</p>
      ) : null}
      {actionError ? <p role="alert" className="og-account-error">{actionError}</p> : null}
      {content}
    </div>
  );
}

function PlansPanel({ plans, pending, onChoose }: {
  plans: AccountPlan[];
  pending?: string;
  onChoose: (planId: number) => void;
}) {
  return (
    <div className="og-account-plans">
      <article className="og-account-plan">
        <h2>Free</h2>
        <strong>{money(0, "USD")}</strong>
        <p>No monthly subscription.</p>
        <span>Use your own providers.</span>
        <button disabled>Included</button>
      </article>
      {plans.map((plan) => (
        <article className="og-account-plan" key={plan.id}>
          <h2>{plan.name}</h2>
          <strong>{money(plan.price, plan.currency)}<small> / month</small></strong>
          <p>{plan.description || "Monthly OpenGame usage credits."}</p>
          <span>{money(plan.monthly_credits, plan.currency)} monthly usage credits</span>
          <button
            type="button"
            disabled={Boolean(pending) || !plan.available}
            onClick={() => onChoose(plan.id)}
          >
            {!plan.available ? "Unavailable" : pending === String(plan.id) ? "Opening..." : "Choose plan"}
          </button>
        </article>
      ))}
      {!plans.length ? <p className="og-account-muted">No paid plans are currently available.</p> : null}
    </div>
  );
}

function BillingPanel({ subscription, pending, onManage }: {
  subscription: AccountSubscription;
  pending: boolean;
  onManage: () => void;
}) {
  return (
    <>
      <div className="og-account-billing-row">
        <div>
          <span className="og-account-muted">Current plan</span>
          <h2>{subscription.current?.plan_name ?? "Free"}</h2>
        </div>
        {subscription.current ? (
          <button type="button" disabled={pending} onClick={onManage}>
            {pending ? "Opening..." : "Manage subscription"}
          </button>
        ) : null}
      </div>
      <div className="og-account-metrics">
        <Metric label="Wallet balance" value={money(subscription.wallet_credits, subscription.currency)} />
        {subscription.current ? (
          <Metric label="Plan credits remaining" value={money(subscription.current.remaining_credits, subscription.currency)} />
        ) : null}
        <Metric label="Account status" value={subscription.account_status === "active" ? "Active" : "Unavailable"} />
      </div>
      {subscription.current ? (
        <p className="og-account-muted">
          {subscription.current.cancel_at_period_end ? "Ends" : "Renews"} {date(subscription.current.renews_at)}. {money(subscription.current.total_credits, subscription.currency)} plan credits per period.
        </p>
      ) : null}
    </>
  );
}

function UsagePanel({ usage, onPageChange }: {
  usage: AccountUsage;
  onPageChange: (page: number) => void;
}) {
  return (
    <>
      <div className="og-account-metrics">
        <Metric label="Total spend" value={money(usage.summary.total_spend, usage.summary.currency)} />
        <Metric label="Wallet balance" value={money(usage.summary.available_balance, usage.summary.currency)} />
        <Metric label="Requests" value={usage.summary.total_requests.toLocaleString()} />
      </div>
      <h2>Usage log</h2>
      {usage.logs.length ? (
        <div className="og-account-table">
          <table>
            <thead><tr><th>Date</th><th>Model</th><th>Tokens</th><th>Amount</th></tr></thead>
            <tbody>
              {usage.logs.map((log) => (
                <tr key={log.id}>
                  <td>{date(log.created_at)}</td>
                  <td>{log.model}</td>
                  <td>{log.prompt_tokens + log.completion_tokens > 0 ? (log.prompt_tokens + log.completion_tokens).toLocaleString() : "N/A"}</td>
                  <td>{money(log.amount, usage.summary.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="og-account-state">No OpenGame usage in this period.</p>}
      <div className="og-account-pagination">
        <span>{usage.pagination.total.toLocaleString()} requests</span>
        <span>Page {usage.pagination.page} of {usage.pagination.total_pages}</span>
        <button
          type="button"
          title="Previous page"
          aria-label="Previous page"
          disabled={usage.pagination.page <= 1}
          onClick={() => onPageChange(usage.pagination.page - 1)}
        >
          <AltArrowLeftIcon size={18} />
        </button>
        <button
          type="button"
          title="Next page"
          aria-label="Next page"
          disabled={usage.pagination.page >= usage.pagination.total_pages}
          onClick={() => onPageChange(usage.pagination.page + 1)}
        >
          <AltArrowRightIcon size={18} />
        </button>
      </div>
    </>
  );
}

function Loading() {
  return <div className="og-account-loading" role="status" aria-label="Loading account"><div /><div /><div /></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function date(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : "Unknown";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Account request failed";
}
