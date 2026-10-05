export const LOCAL_DEBUG_ACCESS_TOKEN = "ohmygame-local-debug-token";
export const LOCAL_DEBUG_USER = {
  id: "local-debug-creator",
  name: "Local Debug Creator",
  email: "creator@localhost",
};

export function isLocalDebugEnabled(development: boolean, supabaseUrl?: string, supabaseKey?: string): boolean {
  return development && !(supabaseUrl?.trim() && supabaseKey?.trim());
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}
