import Fastify, { LogController } from "fastify";
import { expect, it } from "vitest";
import {
  daemonLoggerOptions,
  logFailedRequests,
  requestLogValue,
} from "../src/daemon/request-log.js";

it("logs the request path without its query", () => {
  expect(
    requestLogValue({
      method: "GET",
      url: "/projects/p1/files/location?path=%2FUsers%2Fsomeone%2Fsecret.txt",
      host: "127.0.0.1:43110",
      ip: "127.0.0.1",
      socket: { remotePort: 50_000 },
    }),
  ).toEqual({
    method: "GET",
    url: "/projects/p1/files/location",
    host: "127.0.0.1:43110",
    remoteAddress: "127.0.0.1",
    remotePort: 50_000,
  });
  expect(requestLogValue({ method: "GET", url: "/health" }).url).toBe(
    "/health",
  );
});

it("leaves the computer name and query strings out of daemon log lines", async () => {
  const lines: string[] = [];
  const app = Fastify({
    logger: daemonLoggerOptions({ write: (line) => lines.push(line) }),
  });
  app.get("/health", async () => ({ status: "ok" }));

  await app.inject({ method: "GET", url: "/health?path=/Users/someone" });
  await app.close();

  const entries = lines.map((line) => JSON.parse(line));
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).not.toHaveProperty("hostname");
    expect(entry.pid).toBe(process.pid);
  }
  expect(lines.join("")).not.toContain("/Users/someone");
});

it("logs failed requests by route, and only those", async () => {
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
    entries.map(({ msg, route, statusCode }) => ({ msg, route, statusCode })),
  ).toEqual([
    {
      msg: "Request returned an error",
      route: "/projects/:id",
      statusCode: 404,
    },
    { msg: "Request failed", route: "/broken", statusCode: undefined },
    { msg: "Request returned an error", route: "/broken", statusCode: 500 },
  ]);
  expect(entries[1].err.message).toBe("Could not read the project index");
  expect(entries[1].err.stack).toContain(
    "Error: Could not read the project index",
  );
  expect(lines.join("")).not.toContain("p-123");
});
