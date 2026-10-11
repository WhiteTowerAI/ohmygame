import { createClient, type User } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SignInDialog, type SignInProvider } from "./sign-in-dialog.js";
import { syncCloudSession } from "./api.js";
import { isLocalDebugEnabled, isLoopbackHostname, LOCAL_DEBUG_ACCESS_TOKEN, LOCAL_DEBUG_USER } from "../shared/local-debug.js";

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
export const localDebug = isLocalDebugEnabled(
  import.meta.env.DEV && typeof window !== "undefined" && isLoopbackHostname(window.location.hostname),
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
);
const LOCAL_SESSION_KEY = "ohmygame-local-debug-session";

interface AuthClient {
  auth: Pick<ReturnType<typeof createClient>["auth"], "exchangeCodeForSession" | "getSession" | "onAuthStateChange" | "signInWithOAuth" | "signOut">;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    if (supabase) return { status: "loading" };
    try {
      if (localDebug && localStorage.getItem(LOCAL_SESSION_KEY) === "signed-in") {
        return { status: "signed-in", user: LOCAL_DEBUG_USER };
      }
    } catch { /* Storage may be unavailable in the browser. */ }
    return { status: "signed-out" };
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingProvider, setPendingProvider] = useState<SignInProvider>();
  const [oauthBrowserOpen, setOAuthBrowserOpen] = useState(false);
  const pendingAccessToken = useRef<((token: string | undefined) => void) | undefined>(undefined);
  const cloudSync = useRef(Promise.resolve());
  const cloudSyncRevision = useRef(0);
  function synchronizeCloud(session: { access_token: string; user: User } | null): void {
    const revision = ++cloudSyncRevision.current;
    cloudSync.current = cloudSync.current.catch(() => {}).then(async () => {
      if (revision !== cloudSyncRevision.current) return;
      await syncCloudSession(session ? { accessToken: session.access_token, userId: session.user.id } : null);
    }).catch(() => { /* Login remains available if the local daemon is restarting. */ });
  }

  useEffect(() => {
    if (!supabase) { synchronizeCloud(null); return; }
    const client = supabase;
    let active = true;
    let authRevision = 0;
    const restoreRevision = authRevision;
    const restoreCloudRevision = cloudSyncRevision.current;
    void client.auth.getSession().then(({ data }) => {
      if (!active || restoreRevision !== authRevision || restoreCloudRevision !== cloudSyncRevision.current) return;
      setState(authState(data.session?.user));
      synchronizeCloud(data.session);
    }).catch(() => { if (active && restoreRevision === authRevision && restoreCloudRevision === cloudSyncRevision.current) { setState({ status: "signed-out" }); synchronizeCloud(null); } });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      authRevision++;
      setState(authState(session?.user));
      // Defer API work outside Supabase's auth callback lock.
      queueMicrotask(() => { if (active) synchronizeCloud(session); });
    });
    const timer = setInterval(() => {
      const revision = authRevision, cloudRevision = cloudSyncRevision.current;
      void client.auth.getSession().then(({ data }) => {
        if (active && revision === authRevision && cloudRevision === cloudSyncRevision.current) synchronizeCloud(data.session);
      }).catch(() => {});
    }, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
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
      if (localDebug) {
        signInLocally();
        return;
      }
      setError(undefined);
      setDialogOpen(true);
    },
    requestAccessToken,
    signOut: async () => {
      settleAccessTokenRequest(undefined);
      synchronizeCloud(null);
      if (localDebug) {
        try { localStorage.removeItem(LOCAL_SESSION_KEY); } catch { /* Keep sign-out available without storage. */ }
        setState({ status: "signed-out" });
        return;
      }
      if (!supabase) return;
      await signOut(supabase);
    },
  }), [state]);

  async function requestAccessToken(): Promise<string | undefined> {
    if (localDebug) {
      signInLocally();
      return LOCAL_DEBUG_ACCESS_TOKEN;
    }
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
    synchronizeCloud(null);
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

  function signInLocally(): void {
    try { localStorage.setItem(LOCAL_SESSION_KEY, "signed-in"); } catch { /* A session still works without storage. */ }
    setState({ status: "signed-in", user: LOCAL_DEBUG_USER });
    settleAccessTokenRequest(LOCAL_DEBUG_ACCESS_TOKEN);
    setDialogOpen(false);
    setError(undefined);
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
