import type { McpServerDefinition, PluginConfigurationField, PluginConfigurationValues } from "../shared/plugins.js";
import { PluginConfigurationError } from "./plugin-configuration.js";

// MCP server definitions as the person's connections hold them: secrets live in
// the configuration store and the definition keeps a `${config.name}` reference.

export function isMcpServerDefinition(value: unknown): value is McpServerDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  if ((typeof d.command === "string" && Boolean(d.command.trim())) === (typeof d.url === "string" && Boolean(d.url.trim()))) return false;
  if (d.args !== undefined && (!Array.isArray(d.args) || !d.args.every(a => typeof a === "string"))) return false;
  for (const key of ["env", "headers"]) if (d[key] !== undefined && (!d[key] || typeof d[key] !== "object" || Array.isArray(d[key]) || !Object.values(d[key] as object).every(v => typeof v === "string"))) return false;
  if (typeof d.url === "string" && !d.url.includes("${config.")) {
    try { if (!["http:", "https:"].includes(new URL(d.url).protocol)) return false; } catch { return false; }
  }
  return true;
}

export function substitute(
  value: unknown,
  values: Record<string, string | boolean>,
): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{config\.([a-z0-9_.-]+)\}$/.exec(value);
    if (whole) {
      if (values[whole[1]!] === undefined)
        throw new PluginConfigurationError(
          `Missing configuration: ${whole[1]}`,
        );
      return values[whole[1]!]!;
    }
    return value.replace(/\$\{config\.([a-z0-9_.-]+)\}/g, (_, key: string) => {
      if (values[key] === undefined)
        throw new PluginConfigurationError(`Missing configuration: ${key}`);
      return String(values[key]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, values)]),
    );
  return value;
}
export function protectDefinitions(
  servers: Record<string, McpServerDefinition>,
  fields: Record<string, PluginConfigurationField>,
  values: PluginConfigurationValues,
): Record<string, McpServerDefinition> {
  function visit(value: unknown, parts: string[], sensitive = false): unknown {
    if (
      typeof value === "string" &&
      (sensitive ||
        (parts.at(-1) === "url" && sensitiveUrl(value))) &&
      !value.includes("${config.")
    ) {
      let key = parts
        .join("-")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      while (
        fields[key] &&
        !(
          fields[key]!.type === "secret" &&
          fields[key]!.label === parts.join(" / ")
        )
      )
        key += "-value";
      fields[key] = {
        type: "secret",
        label: parts.join(" / "),
        required: true,
      };
      const argumentPrefix = parts.at(-2) === "args" ? sensitiveArgumentPrefix(value) : undefined;
      values[key] = argumentPrefix ? value.slice(argumentPrefix.length) : value;
      return `${argumentPrefix ?? ""}\${config.${key}}`;
    }
    if (Array.isArray(value))
      return value.map((v, i) => visit(v, [...parts, String(i)], sensitive ||
        (parts.at(-1) === "args" && typeof v === "string" && sensitiveArgument(v, value[i - 1]))));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          visit(
            v,
            [...parts, k],
            sensitive ||
              /^(bearerToken|clientSecret)$/i.test(k) ||
              (parts.at(-1) === "env" &&
                !/^(NODE_ENV|PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_ALL|TZ|PORT|LOG_LEVEL|DEBUG)$/i.test(
                  k,
                )) ||
              (parts.at(-1) === "headers" &&
                !/^(Accept|Accept-Language|Content-Type|User-Agent)$/i.test(k)),
          ),
        ]),
      );
    return value;
  }
  return visit(servers, []) as Record<string, McpServerDefinition>;
}

const SECRET_NAME = /^(?:[a-z0-9]+[-_])*(?:api[-_]?key|key|token|secret|password|passwd|pat|auth|authorization|credentials?|bearer|signature|sig)(?:[-_](?!(?:file|path|dir|url|uri)$)[a-z0-9]+)*$/i;

// Names catch flagged credentials; the value shape catches positional ones and
// URL path segments, so exported packages do not carry literal tokens.
function sensitiveArgument(value: string, previous: unknown): boolean {
  const flag = /^--?([^=]+)=(.*)$/.exec(value);
  if (flag) return SECRET_NAME.test(flag[1]!) || looksLikeSecret(flag[2]!);
  if (value.startsWith("-")) return false;
  return (typeof previous === "string" && /^--?[^=]+$/.test(previous) && SECRET_NAME.test(previous.replace(/^--?/, ""))) ||
    looksLikeSecret(value);
}

function sensitiveArgumentPrefix(value: string): string | undefined {
  return /^--?[^=]+=/.exec(value)?.[0];
}

function looksLikeSecret(value: string): boolean {
  if (/^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}$|^(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$|^glpat-[A-Za-z0-9_-]{16,}$|^xox[abposr]-[A-Za-z0-9-]{10,}$|^AKIA[A-Z0-9]{16}$|^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\./.test(value))
    return true;
  return value.length >= 24 && /^[A-Za-z0-9_-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value);
}

function sensitiveUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password) ||
      [...url.searchParams].some(([key, item]) => SECRET_NAME.test(key) || looksLikeSecret(item)) ||
      url.pathname.split("/").some(looksLikeSecret);
  } catch { return false; }
}
