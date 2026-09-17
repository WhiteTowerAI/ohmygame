import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import { AccountPage, type AccountSection } from "../account-ui/account-page.js";
import type { AccountApi } from "../shared/account.js";

async function accountRequest<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/account-api${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = await response.json() as { data?: T; message?: string };
  if (!response.ok || body.data === undefined) {
    throw new Error(body.message || `Account request failed (${response.status})`);
  }
  return body.data;
}

export const webAccountApi: AccountApi = {
  plans: () => accountRequest("/plans"),
  subscription: (token) => accountRequest("/subscription", token),
  usage: (token, page) => accountRequest(`/usage?page=${page}`, token),
  checkout: (token, planId) => accountRequest("/subscription/checkout", token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan_id: planId }),
  }),
  manage: (token) => accountRequest("/subscription/manage", token, { method: "POST" }),
};

export function WebAccountPage({ section }: { section: AccountSection }) {
  const [client, setClient] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState<string>();
  const [authAttempt, setAuthAttempt] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    setLoadingAuth(true);
    setAuthError(undefined);

    void (async () => {
      const response = await fetch("/account-api/config", {
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Account sign-in is temporarily unavailable");
      const body = await response.json() as {
        data: { supabase_url: string; supabase_publishable_key: string };
      };
      const next = createClient(body.data.supabase_url, body.data.supabase_publishable_key, {
        auth: { flowType: "pkce" },
      });
      const restored = await next.auth.getSession();
      if (restored.error) throw restored.error;
      if (!active) return;

      setClient(next);
      setSession(restored.data.session);
      setLoadingAuth(false);
      const { data } = next.auth.onAuthStateChange((_event, nextSession) => {
        if (!active) return;
        setSession(nextSession);
        if (nextSession) setShowSignIn(false);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    })().catch((cause) => {
      if (!active) return;
      setAuthError(cause instanceof Error ? cause.message : "Sign-in failed");
      setLoadingAuth(false);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [authAttempt]);

  const requestToken = useCallback(async () => {
    if (!client) throw new Error("Account sign-in is unavailable");
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    return data.session?.access_token;
  }, [client]);

  async function signIn(provider: "google" | "github") {
    if (!client) return;
    setSigningIn(true);
    setAuthError(undefined);
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}${window.location.pathname}` },
    });
    if (error) {
      setAuthError(error.message);
      setSigningIn(false);
    }
  }

  async function signOut() {
    const result = await client?.auth.signOut();
    if (result?.error) setAuthError(result.error.message);
  }

  return (
    <main className="content-width web-account">
      <nav className="web-account-nav" aria-label="Account">
        <a href="/pricing" aria-current={section === "plans" ? "page" : undefined}>Plans</a>
        <a href="/account/usage" aria-current={section === "usage" ? "page" : undefined}>Usage</a>
        <a href="/account/billing" aria-current={section === "billing" ? "page" : undefined}>Billing</a>
      </nav>
      {session ? (
        <div className="web-account-profile">
          <span>{session.user.email}</span>
          <button type="button" onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : null}
      {authError && (section !== "plans" || showSignIn) ? (
        <div className="og-account-error" role="alert">
          <p>{authError}</p>
          {!client ? <button type="button" onClick={() => setAuthAttempt((value) => value + 1)}>Try again</button> : null}
        </div>
      ) : null}
      {showSignIn && client ? (
        <div className="web-account-sign-in">
          <h2>Sign in to OpenGame</h2>
          <button type="button" disabled={signingIn} onClick={() => void signIn("google")}>Continue with Google</button>
          <button type="button" disabled={signingIn} onClick={() => void signIn("github")}>Continue with GitHub</button>
        </div>
      ) : null}
      <AccountPage
        section={section}
        api={webAccountApi}
        userId={session?.user.id}
        loadingAuth={loadingAuth}
        requestToken={requestToken}
        onSignIn={() => setShowSignIn(true)}
        openPayment={async (url) => window.location.assign(url)}
      />
    </main>
  );
}
