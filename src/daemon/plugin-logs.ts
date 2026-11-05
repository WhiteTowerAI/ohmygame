import type { PluginLogEntry } from "../shared/plugins.js";

// What each plugin did wrong, and what its native code printed, since the app
// started: kept in memory only, so a restart starts it again, as it does a
// quarantine. Each plugin keeps its last `PLUGIN_LOG_MAX_ENTRIES` entries.

export const PLUGIN_LOG_MAX_ENTRIES = 500;
/** Longer lines are cut to this many characters. */
export const PLUGIN_LOG_MAX_CHARS = 2_000;

export class PluginLogs {
  readonly #entries = new Map<string, PluginLogEntry[]>();

  /** `secrets` gives a plugin's saved secrets as they are now. */
  constructor(private readonly secrets: (plugin: string) => readonly string[] = () => []) {}

  add(plugin: string, entry: Omit<PluginLogEntry, "at">): void {
    // Redacted as it's kept, before it's cut, so a secret changed later, or cut in half, never shows.
    const redacted = redactCredentials(entry.text, this.secrets(plugin));
    const text = redacted.length > PLUGIN_LOG_MAX_CHARS ? `${redacted.slice(0, PLUGIN_LOG_MAX_CHARS - 1)}…` : redacted;
    const entries = this.#entries.get(plugin) ?? [];
    entries.push({ at: new Date().toISOString(), level: entry.level, source: entry.source, text });
    entries.splice(0, Math.max(0, entries.length - PLUGIN_LOG_MAX_ENTRIES));
    this.#entries.set(plugin, entries);
  }

  /** The plugin's entries, oldest first, redacted again with its secrets now, in case one was saved after a line was kept. */
  read(plugin: string): PluginLogEntry[] {
    const secrets = this.secrets(plugin);
    return (this.#entries.get(plugin) ?? []).map((entry) => ({ ...entry, text: redactCredentials(entry.text, secrets) }));
  }

  forget(plugin: string): void {
    this.#entries.delete(plugin);
  }
}

const REDACTED = "[redacted]";

/**
 * Takes out the plugin's saved secrets, wherever they appear, and what looks
 * like a credential: a bearer token, `token=…`, a URL's password, and common
 * key formats. It can't know every format, so it is a safety net, not a promise.
 */
export function redactCredentials(text: string, secrets: readonly string[] = []): string {
  const result = withoutSecrets(text, secrets.filter((value) => value.length >= 4));
  return result
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, `$1${REDACTED}`)
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, REDACTED)
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, REDACTED)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);
}

/**
 * Every place a saved secret shows, whole or, where the extension host cut a
 * line with "…", as its start. They're found in the text as it came and
 * merged, so secrets that overlap or contain each other go together.
 */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  const ranges: Array<[number, number]> = [];
  for (const secret of secrets)
    for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) ranges.push([at, at + secret.length]);
  if (text.endsWith("…")) {
    const end = text.length - 1;
    const body = text.slice(0, end);
    for (const secret of secrets)
      for (let length = secret.length - 1; length > 0; length -= 1)
        if (body.endsWith(secret.slice(0, length))) {
          ranges.push([end - length, end]);
          break;
        }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let result = "";
  let from = 0;
  for (let index = 0; index < ranges.length; ) {
    const start = ranges[index]![0];
    let stop = ranges[index]![1];
    for (index += 1; index < ranges.length && ranges[index]![0] <= stop; index += 1) stop = Math.max(stop, ranges[index]![1]);
    result += `${text.slice(from, start)}${REDACTED}`;
    from = stop;
  }
  return result + text.slice(from);
}
