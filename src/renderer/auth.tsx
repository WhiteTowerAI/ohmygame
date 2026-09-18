import { createClient, type User } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SignInDialog, type SignInProvider } from "./sign-in-dialog.js";
import { connectAccount, disconnectAccount } from "./api.js";

export type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; user: AuthUser };

export interface AuthUser {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

interface AuthContextValue {
  state: AuthState;
  openSignIn: () => void;
  requestAccessToken: () => Promise<string | undefined>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
const supabase = createSupabaseClient();
const ACCOUNT_RETRY_INITIAL_MS = 5_000;
const ACCOUNT_RETRY_MAX_MS = 60_000;

interface AuthClient {
  auth: Pick<ReturnType<typeof createClient>["auth"], "exchangeCodeForSession" | "getSession" | "onAuthStateChange" | "signInWithOAuth" | "signOut">;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(supabase ? { status: "loading" } : { status: "signed-out" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingProvider, setPendingProvider] = useState<SignInProvider>();
  const [oauthBrowserOpen, setOAuthBrowserOpen] = useState(false);
  const pendingAccessToken = useRef<((token: string | undefined) => void) | undefined>(undefined);
  const accountUserId = useRef<string | undefined>(undefined);
  const connectingAccountUserId = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryUserId: string | undefined;
    let retryDelay = ACCOUNT_RETRY_INITIAL_MS;

    function scheduleRetry(userId: string): void {
      if (!active || retryUserId !== userId) return;
      if (retryTimer) clearTimeout(retryTimer);
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, ACCOUNT_RETRY_MAX_MS);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void getAccessToken(client).then((token) => {
          if (!active || retryUserId !== userId) return;
          if (token) connect(userId, token);
          else scheduleRetry(userId);
        }).catch(() => scheduleRetry(userId));
      }, delay);
    }

    function connect(userId: string, accessToken: string): void {
      if (userId === accountUserId.current || userId === connectingAccountUserId.current) return;
      accountUserId.current = undefined;
      if (retryTimer) clearTimeout(retryTimer);
      if (retryUserId !== userId) retryDelay = ACCOUNT_RETRY_INITIAL_MS;
      retryUserId = userId;
      connectingAccountUserId.current = userId;
      void connectAccount(accessToken).then(() => {
        if (active && connectingAccountUserId.current === userId) {
          accountUserId.current = userId;
          retryDelay = ACCOUNT_RETRY_INITIAL_MS;
        }
      }).catch(() => {
        if (connectingAccountUserId.current === userId) scheduleRetry(userId);
      }).finally(() => {
        if (connectingAccountUserId.current === userId) connectingAccountUserId.current = undefined;
      });
    }
    void restoreAuthState(client).then((restored) => {
      if (!active) return;
      setState(restored);
      if (restored.status === "signed-in") {
        void getAccessToken(client).then(async (token) => {
          if (token) connect(restored.user.id, token);
        }).catch(() => undefined);
      } else {
        void disconnectAccount().catch(() => undefined);
      }
    });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setState(authState(session?.user));
      const userId = session?.user.id;
      if (userId) {
        connect(userId, session.access_token);
      } else {
        if (retryTimer) clearTimeout(retryTimer);
        retryUserId = undefined;
        retryDelay = ACCOUNT_RETRY_INITIAL_MS;
        accountUserId.current = undefined;
        connectingAccountUserId.current = undefined;
        void disconnectAccount().catch(() => undefined);
      }
    });
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
      retryUserId = undefined;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const desktopAuth = window.ohMyGameDesktop?.auth;
    if (!supabase || !desktopAuth) return;
    let active = true;
    const consume = async () => {
      try {
        const callback = await desktopAuth.takeCallback();
        if (!callback || !active) return;
        await exchangeDesktopCallback(supabase, callback);
        const accessToken = await getAccessToken(supabase);
        if (!accessToken) throw new Error("Sign-in did not create a session");
        if (active) {
          settleAccessTokenRequest(accessToken);
          setDialogOpen(false);
          setPendingProvider(undefined);
          setOAuthBrowserOpen(false);
        }
      } catch (callbackError) {
        if (active) {
          setDialogOpen(true);
          setPendingProvider(undefined);
          setOAuthBrowserOpen(false);
          setError(errorMessage(callbackError));
        }
      }
    };
    const unsubscribe = desktopAuth.onCallback(() => void consume());
    void consume();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    state,
    openSignIn: () => {
      setError(undefined);
      setDialogOpen(true);
    },
    requestAccessToken,
    signOut: async () => {
      if (!supabase) return;
      settleAccessTokenRequest(undefined);
      await signOut(supabase);
    },
  }), [state]);

  async function requestAccessToken(): Promise<string | undefined> {
    if (!supabase) {
      setError("Supabase Auth is not configured.");
      setDialogOpen(true);
      return undefined;
    }
    try {
      const accessToken = await getAccessToken(supabase);
      if (accessToken) return accessToken;
      setError(undefined);
    } catch {
      setError("Your session expired. Sign in again.");
    }
    setState({ status: "signed-out" });
    setPendingProvider(undefined);
    setOAuthBrowserOpen(false);
    setDialogOpen(true);
    return new Promise((resolve) => {
      settleAccessTokenRequest(undefined);
      pendingAccessToken.current = resolve;
    });
  }

  function settleAccessTokenRequest(accessToken: string | undefined): void {
    const resolve = pendingAccessToken.current;
    pendingAccessToken.current = undefined;
    resolve?.(accessToken);
  }

  async function signIn(provider: SignInProvider) {
    if (!supabase) {
      setError("Supabase Auth is not configured.");
      return;
    }
    setPendingProvider(provider);
    setOAuthBrowserOpen(false);
    setError(undefined);
    try {
      const desktopAuth = window.ohMyGameDesktop?.auth;
      if (desktopAuth) {
        const authorizationUrl = await createOAuthAuthorizationUrl(supabase, provider, await desktopAuth.callbackUrl());
        await desktopAuth.openUrl(authorizationUrl);
        setOAuthBrowserOpen(true);
      } else {
        await startOAuth(supabase, provider, `${window.location.origin}${window.location.pathname}${window.location.hash}`);
      }
    } catch (signInError) {
      await window.ohMyGameDesktop?.auth.cancel().catch(() => undefined);
      setError(errorMessage(signInError));
      setPendingProvider(undefined);
      setOAuthBrowserOpen(false);
    }
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
      {dialogOpen ? (
        <SignInDialog
          configured={Boolean(supabase)}
          error={error}
          allowClose={oauthBrowserOpen}
          pendingProvider={pendingProvider}
          onClose={() => {
            void window.ohMyGameDesktop?.auth.cancel().catch(() => undefined);
            settleAccessTokenRequest(undefined);
            setDialogOpen(false);
            setError(undefined);
            setPendingProvider(undefined);
            setOAuthBrowserOpen(false);
          }}
          onSignIn={(provider) => void signIn(provider)}
        />
      ) : null}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

export function authUser(user: User): AuthUser {
  const metadata = user.user_metadata;
  const name = stringValue(metadata.full_name) ?? stringValue(metadata.name)
    ?? stringValue(metadata.user_name) ?? user.email ?? "OhMyGame creator";
  return {
    id: user.id,
    name,
    email: user.email,
    avatarUrl: stringValue(metadata.avatar_url) ?? stringValue(metadata.picture),
  };
}

export async function restoreAuthState(client: AuthClient): Promise<AuthState> {
  try {
    const { data } = await client.auth.getSession();
    return authState(data.session?.user);
  } catch {
    return { status: "signed-out" };
  }
}

export async function getAccessToken(client: AuthClient): Promise<string | undefined> {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token;
}

export async function startOAuth(client: AuthClient, provider: SignInProvider, redirectTo: string): Promise<void> {
  const { error } = await client.auth.signInWithOAuth({ provider, options: { redirectTo } });
  if (error) throw error;
}

export async function createOAuthAuthorizationUrl(
  client: AuthClient,
  provider: SignInProvider,
  redirectTo: string,
): Promise<string> {
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data.url) throw new Error("Supabase did not return an OAuth authorization URL");
  return data.url;
}

export async function exchangeDesktopCallback(client: AuthClient, callback: string): Promise<void> {
  const url = new URL(callback);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/auth/callback/")) {
    throw new Error("Invalid OAuth callback");
  }
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) throw new Error(providerError);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("OAuth callback did not include an authorization code");
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) throw error;
}

export async function signOut(client: AuthClient): Promise<void> {
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

function authState(user: User | undefined): AuthState {
  return user ? { status: "signed-in", user: authUser(user) } : { status: "signed-out" };
}

export function createSupabaseClient(
  configuredUrl = import.meta.env.VITE_SUPABASE_URL,
  configuredKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
): AuthClient | undefined {
  const url = configuredUrl?.trim();
  const key = configuredKey?.trim();
  if (!url || !key) return undefined;
  return createClient(url, key, { auth: { flowType: "pkce" } });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
