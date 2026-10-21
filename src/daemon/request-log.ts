import type { FastifyInstance } from "fastify";

/**
 * The daemon's pino options. pino adds the computer name to every line by
 * default, and it often includes the person's name.
 */
export function daemonLoggerOptions(stream?: { write(line: string): void }) {
  return {
    base: { pid: process.pid },
    ...(stream ? { stream } : {}),
  };
}

/**
 * The renderer polls the daemon, so a line per request buries what matters.
 * Log only requests that fail, by route pattern so IDs and paths stay out,
 * and the stack of errors the daemon did not expect.
 */
export function logFailedRequests(app: FastifyInstance): void {
  app.addHook("onError", async (request, _reply, error) => {
    if ((error.statusCode ?? 500) < 500) return;
    request.log.error(
      { err: error, method: request.method, route: request.routeOptions.url },
      "Request failed",
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) return;
    request.log.warn(
      {
        method: request.method,
        route: request.routeOptions.url ?? "(no route)",
        statusCode: reply.statusCode,
        responseTime: Math.round(reply.elapsedTime),
      },
      "Request returned an error",
    );
  });
}
