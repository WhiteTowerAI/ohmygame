import { expect, it } from "vitest";
import { PLUGIN_LOG_MAX_CHARS, PLUGIN_LOG_MAX_ENTRIES, PluginLogs, redactCredentials } from "../src/daemon/plugin-logs.js";

it("keeps each plugin's latest lines, cut to length", () => {
  const logs = new PluginLogs();
  for (let line = 0; line < PLUGIN_LOG_MAX_ENTRIES + 5; line += 1) logs.add("acme/maker", { level: "info", source: "native", text: `line ${line}` });
  logs.add("acme/other", { level: "error", source: "call", text: "x".repeat(PLUGIN_LOG_MAX_CHARS + 10) });
  const maker = logs.read("acme/maker");
  expect(maker).toHaveLength(PLUGIN_LOG_MAX_ENTRIES);
  expect(maker[0]!.text).toBe("line 5");
  expect(maker[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(logs.read("acme/other")[0]!.text).toHaveLength(PLUGIN_LOG_MAX_CHARS);
  logs.forget("acme/maker");
  expect(logs.read("acme/maker")).toEqual([]);
});

it("redacts saved secrets and what looks like a credential before anyone reads the log", () => {
  let saved = ["s3cr3t-value"];
  const logs = new PluginLogs(() => saved);
  logs.add("acme/maker", { level: "error", source: "call", text: "Login with s3cr3t-value failed" });
  // Changing the secret afterwards doesn't bring the old one back.
  saved = ["n3w-value"];
  logs.add("acme/maker", { level: "error", source: "call", text: "Then n3w-value failed" });
  expect(logs.read("acme/maker").map((entry) => entry.text)).toEqual(["Login with [redacted] failed", "Then [redacted] failed"]);
  // A secret at the cut is redacted before the line is cut, so no part of it stays.
  saved = ["abcdefgh"];
  logs.add("acme/cut", { level: "info", source: "native", text: `${"x".repeat(PLUGIN_LOG_MAX_CHARS - 4)}abcdefgh` });
  expect(logs.read("acme/cut")[0]!.text).not.toContain("abcd");
  expect(redactCredentials("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
  expect(redactCredentials("sent Bearer abcdefghijklmnop")).toBe("sent Bearer [redacted]");
  expect(redactCredentials("GET https://user:hunter22@example.com/x?token=abc123&page=2")).toBe("GET https://user:[redacted]@example.com/x?token=[redacted]&page=2");
  expect(redactCredentials('{"api_key": "k-123456", "name": "ok"}')).toBe('{"api_key": "[redacted]", "name": "ok"}');
  expect(redactCredentials("key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("key [redacted] and [redacted]");
  expect(redactCredentials("AKIAABCDEFGHIJKLMNOP eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4f")).toBe("[redacted] [redacted]");
  // Plain text stays as it is, and a secret too short to be one isn't hunted for.
  expect(redactCredentials("Built 3 levels in 2s", ["ab"])).toBe("Built 3 levels in 2s");
});
