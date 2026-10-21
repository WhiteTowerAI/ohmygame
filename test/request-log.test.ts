import Fastify, { LogController } from "fastify";
import { expect, it } from "vitest";
import {
  daemonLoggerOptions,
  logFailedRequests,
} from "../src/daemon/request-log.js";

it("leaves the computer name out of daemon log lines", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: daemonLoggerOptions({ write: (line) => lines.push(line) }),
  });
  app.get("/health", async () => ({ status: "ok" }));

  await app.inject({ method: "GET", url: "/health" });
  await app.close();

  const entries = lines.map((line) => JSON.parse(line));
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).not.toHaveProperty("hostname");
    expect(entry.pid).toBe(process.pid);
  }
});

it("logs each failed request once, by route", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: daemonLoggerOptions({ write: (line) => lines.push(line) }),
    logController: new LogController({ disableRequestLogging: true }),
  });
  logFailedRequests(app);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/projects/:id", async (_request, reply) => reply.code(404).send());
  app.get("/broken", async () => {
    throw new Error("Could not read the project index");
  });

  await app.inject({ method: "GET", url: "/health" });
  await app.inject({
    method: "GET",
    url: "/projects/p-123?path=/Users/someone",
  });
  await app.inject({ method: "GET", url: "/broken" });
  await app.close();

  const entries = lines.map((line) => JSON.parse(line));
  expect(
    entries.map(({ level, msg, route, statusCode }) => ({
      level,
      msg,
      route,
      statusCode,
    })),
  ).toEqual([
    {
      level: 40,
      msg: "Request returned an error",
      route: "/projects/:id",
      statusCode: 404,
    },
    { level: 50, msg: "Request failed", route: "/broken", statusCode: 500 },
  ]);
  expect(entries[1].err.message).toBe("Could not read the project index");
  expect(entries[1].err.stack).toContain(
    "Error: Could not read the project index",
  );
  expect(lines.join("")).not.toContain("p-123");
});
