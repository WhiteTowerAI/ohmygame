import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RotatingLogFile } from "../src/desktop/log-file.js";
import { createLogRedactor } from "../src/desktop/log-redaction.js";

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
  it("writes whole lines with a timestamp and keeps partial lines until they end", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "daemon", now });

    log.write("first line\nsecond ");
    log.write(Buffer.from("line\r\nunfinished"));
    expect(await readFile(log.path, "utf8")).toBe(
      "2026-10-21T08:00:00.000Z first line\n2026-10-21T08:00:00.000Z second line\n",
    );
    log.close();
    expect(await readFile(log.path, "utf8")).toContain(
      "2026-10-21T08:00:00.000Z unfinished\n",
    );
  });

  it("keeps characters that are split between two chunks", async () => {
    const directory = await logDirectory();
    const log = new RotatingLogFile({ directory, name: "daemon", now });
    const bytes = Buffer.from("无法读取项目「冒险」\n");

    log.write(bytes.subarray(0, 4));
    log.write(bytes.subarray(4));
    log.close();
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
    log.close();
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

  it("stops quietly when the log cannot be written", async () => {
    const directory = await logDirectory();
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "not a folder");
    const log = new RotatingLogFile({ directory: blocked, name: "daemon" });

    expect(() => log.write("line\n")).not.toThrow();
    expect(() => log.close()).not.toThrow();
  });
});

describe("log redaction", () => {
  it("replaces the home folder only at a path boundary", () => {
    const redact = createLogRedactor("/home/someone", "linux");

    expect(redact("cwd=/home/someone/game /home/someoneelse")).toBe(
      "cwd=~/game /home/someoneelse",
    );
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
