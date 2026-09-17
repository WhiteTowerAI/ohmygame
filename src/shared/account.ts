export interface AccountPlan {
  id: number;
  name: string;
  description: string;
  price: number;
  currency: string;
  monthly_credits: number;
  available: boolean;
}

export interface AccountSubscription {
  wallet_credits: number;
  used_wallet_credits: number;
  account_status: "active" | "unavailable";
  currency: string;
  current: {
    plan_id: number;
    plan_name: string;
    remaining_credits: number;
    total_credits: number;
    renews_at: string;
    cancel_at_period_end: boolean;
  } | null;
}

export interface AccountUsage {
  summary: { total_spend: number; available_balance: number; total_requests: number; currency: string; range_days: number };
  logs: Array<{ id: number; created_at: string; model: string; prompt_tokens: number; completion_tokens: number; amount: number }>;
  pagination: { page: number; total: number; total_pages: number };
}

export interface AccountApi {
  plans(): Promise<AccountPlan[]>;
  subscription(token: string): Promise<AccountSubscription>;
  usage(token: string, page: number): Promise<AccountUsage>;
  checkout(token: string, planId: number): Promise<{ url: string }>;
  manage(token: string): Promise<{ url: string }>;
}

export function paymentUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Invalid payment URL");
  }
  return url.href;
}
