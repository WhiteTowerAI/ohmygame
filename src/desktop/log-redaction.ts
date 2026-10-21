import os from "node:os";
import path from "node:path";
import { sanitizeDiagnosticText } from "@earendil-works/pi-ai/utils/provider-failure";

/** Longer lines are cut, so one runaway write cannot fill a log file. */
export const MAX_LOG_LINE_LENGTH = 16_000;

/**
 * Removes keys, tokens and URL credentials and queries from a log line, and
 * shows the home folder as `~` so a shared log does not carry the account name.
 */
export function createLogRedactor(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): (line: string) => string {
  const homePattern = homeFolderPattern(home, platform);
  return (line) => {
    const text = sanitizeDiagnosticText(line, MAX_LOG_LINE_LENGTH) ?? "";
    return homePattern ? text.replace(homePattern, "~") : text;
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
