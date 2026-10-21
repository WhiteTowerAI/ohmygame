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
 * Log each request that fails once, by route pattern so IDs and paths stay
 * out, with the stack of errors the daemon did not expect.
 */
export function logFailedRequests(app: FastifyInstance): void {
  const unexpected = new WeakMap<object, Error>();
  app.addHook("onError", async (request, _reply, error) => {
    if ((error.statusCode ?? 500) >= 500) unexpected.set(request, error);
  });
  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 400) return;
    const details = {
      method: request.method,
      route: request.routeOptions.url ?? "(no route)",
      statusCode: reply.statusCode,
      responseTime: Math.round(reply.elapsedTime),
    };
    if (reply.statusCode < 500) {
      request.log.warn(details, "Request returned an error");
      return;
    }
    const error = unexpected.get(request);
    request.log.error(
      error ? { ...details, err: error } : details,
      "Request failed",
    );
  });
}
