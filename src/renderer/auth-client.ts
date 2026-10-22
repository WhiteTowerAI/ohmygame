import { createClient } from "@supabase/supabase-js";

/** Shared OAuth project and browser session for the editor and published games. */
export function createSupabaseClient(
  configuredUrl = import.meta.env.VITE_SUPABASE_URL,
  configuredKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
): ReturnType<typeof createClient> | undefined {
  const url = configuredUrl?.trim();
  const key = configuredKey?.trim();
  if (!url || !key) return undefined;
  return createClient(url, key, { auth: { flowType: "pkce" } });
}
