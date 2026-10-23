import os from "node:os";
import path from "node:path";
import { sanitizeDiagnosticText } from "@earendil-works/pi-ai/utils/provider-failure";

/** Longer lines are cut, so one runaway write cannot fill a log file. */
export const MAX_LOG_LINE_LENGTH = 16_000;
export const MAX_LOG_INPUT_LENGTH = MAX_LOG_LINE_LENGTH * 4;
export const OMITTED_LOG_TEXT = "[diagnostic text omitted: too long]";
const SENSITIVE_FIELD =
  /^(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret|cookie)$/i;

interface LogTextOptions {
  maxLength?: number;
  tail?: boolean;
}

/**
 * Removes keys, tokens and URL credentials and queries from a log line, and
 * shows the home folder as `~` so a shared log does not carry the account name.
 */
export function createLogRedactor(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): (line: string, options?: LogTextOptions) => string {
  const homePattern = homeFolderPattern(home, platform);
  const redact = (line: string, depth = 0): string => {
    // Do not cut a serialized string before decoding it: a cut can hide its
    // credential field from the sanitizer while leaving the value visible.
    if (line.length > MAX_LOG_INPUT_LENGTH) return OMITTED_LOG_TEXT;
    if (/^\s*\{\s*"/.test(line)) {
      try {
        JSON.parse(line);
      } catch {
        return "[diagnostic text omitted: incomplete JSON]";
      }
    }
    const fields = line.replace(
      /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/g,
      (entry, key: string, separator: string) => {
        try {
          return SENSITIVE_FIELD.test(JSON.parse(key))
            ? `${key}${separator}"[redacted]"`
            : entry;
        } catch {
          return entry;
        }
      },
    );
    // pino quotes errors and tool output. Decode string literals, sanitize
    // their contents, and quote them again, including nested JSON output.
    const decoded = fields.replace(/"(?:\\.|[^"\\])*"/g, (literal) => {
      if (!literal.includes("\\")) return literal;
      if (depth >= 8) return '"[redacted nested value]"';
      try {
        return JSON.stringify(redact(JSON.parse(literal), depth + 1));
      } catch {
        return literal;
      }
    });
    // Node's console formatter uses single quotes (or backticks) for object
    // values. Keep spaces, separators and escaped quotes inside the value.
    const quoted = decoded.replace(
      /(\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|password|secret|cookie)["']?\s*[:=]\s*)(["'`])(?:\\[\s\S]?|(?!\2)[^\\])*(?:\2|$)/gi,
      (_entry, field: string, quote: string) =>
        `${field}${quote}[redacted]${quote}`,
    );
    // An unquoted Cookie header may contain multiple credentials separated
    // by semicolons. None of that header's remainder is safe to keep.
    const cookies = quoted.replace(
      /(\bcookie["']?\s*[:=]\s*)(?!\s*["'`])[^\r\n]+/gi,
      "$1[redacted]",
    );
    const text = sanitizeDiagnosticText(cookies, MAX_LOG_INPUT_LENGTH) ?? "";
    return homePattern ? text.replace(homePattern, "~") : text;
  };
  return (line, { maxLength = MAX_LOG_LINE_LENGTH, tail = false } = {}) => {
    // Truncating first can remove a credential's field name or closing quote.
    const text = redact(line);
    return tail ? text.slice(-maxLength) : text.slice(0, maxLength);
  };
}

function homeFolderPattern(
  home: string,
  platform: NodeJS.Platform,
): RegExp | undefined {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  if (!home || pathModule.parse(home).root === home) return undefined;
  // Windows paths also appear with forward slashes and JSON-escaped backslashes.
  const forms = new Set([
    home,
    home.replaceAll("\\", "/"),
    home.replaceAll("\\", "\\\\"),
  ]);
  const alternatives = [...forms]
    .sort((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Any character that cannot continue the account name ends the home folder.
  return new RegExp(
    `(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_-])`,
    platform === "win32" ? "giu" : "gu",
  );
}
