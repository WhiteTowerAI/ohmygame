import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLogFile } from "../src/desktop/log-file.js";
import { createLogRedactor } from "../src/shared/log-redaction.js";
import { daemonLoggerOptions } from "../src/daemon/request-log.js";
import {
  recordConsole,
  recordUncaughtErrors,
} from "../src/desktop/console-log.js";

const directories: string[] = [];
const now = () => new Date("2026-10-21T08:00:00.000Z");

async function logDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-logs-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("rotating log file", () => {
  it.each(["console", "fatal"])(
    "preserves cross-line credential fields until redaction: %s",
    async (source) => {
      const log = new RotatingLogFile({
        directory: await logDirectory(),
        name: "main",
        redact: createLogRedactor(),
      });
      const message =
        "Request rejected: password:\n'fixture_multiline_secret with spaces'";
      if (source === "console") {
        const noop = (..._values: unknown[]) => {};
        const target = {
          debug: noop,
          log: noop,
          info: noop,
          warn: noop,
          error: noop,
        };
        recordConsole(log, target);
        target.error(message);
      } else {
        let listener: (error: Error, origin: string) => void = () => {};
        recordUncaughtErrors(log, {
          on: ((_name: string, callback: typeof listener) => {
            listener = callback;
          }) as never,
        });
        const error = new Error(message);
        error.stack = `Error: ${message}`;
        listener(error, "uncaughtException");
      }
      await log.close();
      const text = await readFile(log.path, "utf8");
      expect(text).not.toContain("fixture_multiline_secret");
      expect(text).toContain("Request rejected");
      expect(text).toContain("[redacted]");
    },
  );
  it("redacts console object values and multiline credentials before splitting lines", async () => {
    const log = new RotatingLogFile({
      directory: await logDirectory(),
      name: "main",
      redact: createLogRedactor(),
    });
    const noop = (..._values: unknown[]) => {};
    const target = {
      debug: noop,
      log: noop,
      info: noop,
      warn: noop,
      error: noop,
    };
    recordConsole(log, target);
    target.error("Proxy failed", {
      password: "fixture password with spaces",
      cookie: "session=fixture_cookie; refresh=fixture_refresh",
    });
    log.line("password: 'multiline_first\nmultiline_second'");
    await log.close();
    const text = await readFile(log.path, "utf8");
    for (const secret of ["fixture", "multiline_first", "multiline_second"])
      expect(text).not.toContain(secret);
    expect(text).toContain("Proxy failed");
    expect(text).toContain("[redacted]");
  });
  it("writes whole lines with a timestamp and keeps partial lines until they end", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "daemon", now });

    log.write("first line\nsecond ");
    log.write(Buffer.from("line\r\nunfinished"));
    await log.idle();
    expect(await readFile(log.path, "utf8")).toBe(
      "2026-10-21T08:00:00.000Z first line\n2026-10-21T08:00:00.000Z second line\n",
    );
    await log.close();
    expect(await readFile(log.path, "utf8")).toContain(
      "2026-10-21T08:00:00.000Z unfinished\n",
    );
  });

  it("timestamps each line of a multi-line entry", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "main", now });

    log.line(
      "[service] error (generation 1): Daemon exited before becoming ready (1)\r\n\nDaemon output:\nCould not read project metadata",
    );
    await log.close();
    expect(await readFile(log.path, "utf8")).toBe(
      [
        "2026-10-21T08:00:00.000Z [service] error (generation 1): Daemon exited before becoming ready (1)",
        "2026-10-21T08:00:00.000Z ",
        "2026-10-21T08:00:00.000Z Daemon output:",
        "2026-10-21T08:00:00.000Z Could not read project metadata",
        "",
      ].join("\n"),
    );
  });

  it("keeps characters that are split between two chunks", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "daemon", now });
    const bytes = Buffer.from("无法读取项目「冒险」\n");

    log.write(bytes.subarray(0, 4));
    log.write(bytes.subarray(4));
    await log.close();
    expect(await readFile(log.path, "utf8")).toBe(
      "2026-10-21T08:00:00.000Z 无法读取项目「冒险」\n",
    );
  });

  it("redacts each line before writing it", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({
      directory,
      name: "daemon",
      now,
      redact: createLogRedactor("/Users/someone", "darwin"),
    });

    log.write(
      'Request failed {"apiKey":"abc123","path":"/Users/someone/Projects/game"} key sk-abcdefghijklmnop\n',
    );
    await log.close();
    const text = await readFile(log.path, "utf8");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("/Users/someone");
    expect(text).toContain('"path":"~/Projects/game"');
  });

  it("keeps only the newest files", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({
      directory,
      name: "main",
      now,
      maxBytes: 80,
      maxFiles: 3,
    });

    for (let index = 0; index < 8; index++)
      log.write(`line ${index} ${"x".repeat(30)}\n`);
    await log.close();
    expect((await readdir(directory)).sort()).toEqual([
      "main.1.log",
      "main.2.log",
      "main.log",
    ]);
    expect(await readFile(path.join(directory, "main.log"), "utf8")).toContain(
      "line 7",
    );
    const oldest = await readFile(path.join(directory, "main.2.log"), "utf8");
    expect(oldest).toContain("line 5");
    expect(oldest).not.toContain("line 4");
  });

  it("redacts JSON credentials after the daemon serializes an error", async () => {
    const log = new RotatingLogFile({
      directory: await logDirectory(),
      name: "daemon",
      redact: createLogRedactor(),
    });
    const app = Fastify({
      logger: daemonLoggerOptions({ write: (line) => log.write(line) }),
    });
    try {
      app.log.warn(
        {
          error: JSON.stringify({
            apiKey: "msy_fixture_key",
            password: 'fixture password with "quotes"',
            nested: JSON.stringify({ access_token: "fixture_token" }),
          }),
        },
        "Agent tool failed",
      );
    } finally {
      await app.close();
      await log.close();
    }
    const text = await readFile(log.path, "utf8");
    for (const secret of [
      "msy_fixture_key",
      "fixture password",
      "fixture_token",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("Agent tool failed");
    expect(text).toContain("[redacted]");
  });

  it("writes waiting lines synchronously when the process is about to end", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "main", now });

    log.line("[fatal] uncaughtException: Error: boom");
    log.flushSync();
    expect(readFileSync(log.path, "utf8")).toBe(
      "2026-10-21T08:00:00.000Z [fatal] uncaughtException: Error: boom\n",
    );
    await log.close();
    expect(await readFile(log.path, "utf8")).toBe(
      "2026-10-21T08:00:00.000Z [fatal] uncaughtException: Error: boom\n",
    );
  });

  it("omits oversized chunked records and partial JSON left by a crashed process", async () => {
    const log = new RotatingLogFile({
      directory: await logDirectory(),
      name: "daemon",
      redact: createLogRedactor(),
    });
    const record = JSON.stringify({
      error: `${JSON.stringify({ apiKey: "msy_chunked_fixture" })}${"x".repeat(100_000)}`,
    });
    log.write(record.slice(0, 70_000));
    log.write(`${record.slice(70_000)}\nnext line\n`);
    log.write(
      JSON.stringify({
        error: JSON.stringify({ password: "partial_fixture" }),
      }).slice(0, -2),
    );
    await log.close();
    const text = await readFile(log.path, "utf8");
    expect(text).toContain("next line");
    expect(text).toContain("[diagnostic text omitted: too long]");
    expect(text).toContain("[diagnostic text omitted: incomplete JSON]");
    expect(text).not.toContain("msy_chunked_fixture");
    expect(text).not.toContain("partial_fixture");
  });

  it("stops quietly when the log cannot be written", async () => {
    const directory = await logDirectory();
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "not a folder");
    const log = new RotatingLogFile({ directory: blocked, name: "daemon" });

    expect(() => log.write("line\n")).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
  });
});

describe("log redaction", () => {
  it.each([
    "password='fixture with spaces and \\'quotes\\''",
    "password='fixture without a closing quote",
    "secret=`fixture with \"double\" and 'single' quotes`",
    "Cookie: session=fixture_cookie; refresh=fixture_refresh",
    "{ cookie: 'session=fixture_cookie; refresh=fixture_refresh', code: 'EPERM' }",
    JSON.stringify({ error: "{ password: 'fixture with spaces' }" }),
  ])("redacts quoted credentials and whole Cookie headers: %s", (text) => {
    const redacted = createLogRedactor()(text);
    expect(redacted).not.toContain("fixture");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts complete records before selecting either end", () => {
    const redact = createLogRedactor();
    const text = `api_key=msy_fixture_tail_secret\n${"x".repeat(476)}`;
    expect(redact(text, { maxLength: 500, tail: true })).not.toContain(
      "msy_fixture_tail_secret",
    );
    const long = `${"x".repeat(20_000)}\nlast error api_key=fixture_key`;
    expect(redact(long, { maxLength: 500, tail: true })).toContain(
      "last error api_key=[redacted]",
    );
    expect(
      redact('password="fixture with spaces"', { maxLength: 20 }),
    ).not.toContain("fixture");
  });
  it("omits oversized or deeply nested encoded values before cutting their credentials", () => {
    const redact = createLogRedactor();
    const oversized = JSON.stringify({
      error: `api_key=fixture_key ${"x".repeat(70_000)}`,
    });
    expect(redact(oversized)).toBe("[diagnostic text omitted: too long]");
    let nested = "api_key=fixture_key";
    for (let depth = 0; depth < 10; depth++)
      nested = JSON.stringify({ error: nested });
    expect(redact(nested)).not.toContain("fixture_key");
    expect(redact(nested)).toContain("[redacted");
  });

  it("replaces the home folder only at a path boundary", () => {
    const redact = createLogRedactor("/home/someone", "linux");

    expect(redact("cwd=/home/someone/game /home/someoneelse")).toBe(
      "cwd=~/game /home/someoneelse",
    );
  });

  it("ends the home folder at any character that cannot continue the account name", () => {
    const redact = createLogRedactor("/Users/alice", "darwin");

    expect(
      redact(
        "Could not create /Users/alice. Then /Users/alice|grep, </Users/alice>, `/Users/alice`",
      ),
    ).toBe("Could not create ~. Then ~|grep, <~>, `~`");
    expect(redact("/Users/alice_b /Users/alice-b /Users/alice2")).toBe(
      "/Users/alice_b /Users/alice-b /Users/alice2",
    );
    expect(
      createLogRedactor(
        "/Users/张三",
        "darwin",
      )("/Users/张三/游戏 /Users/张三丰"),
    ).toBe("~/游戏 /Users/张三丰");
  });

  it("replaces Windows home folders in every spelling", () => {
    const redact = createLogRedactor("C:\\Users\\Someone", "win32");

    expect(
      redact(
        String.raw`C:\Users\Someone\game c:/users/someone/game {"cwd":"C:\\Users\\Someone\\game"}`,
      ),
    ).toBe(String.raw`~\game ~/game {"cwd":"~\\game"}`);
  });

  it("removes bearer tokens and URL queries", () => {
    const redact = createLogRedactor("/Users/someone", "darwin");

    expect(
      redact(
        "sent Bearer abc.def to https://user:pass@example.com/v1?key=secret",
      ),
    ).toBe("sent Bearer [redacted] to https://example.com/v1");
  });
});
