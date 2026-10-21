interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number } | null;
}

/**
 * Request logs keep the route and drop the query, which can carry file paths,
 * prompts and other personal values.
 */
export function requestLogValue(request: LoggedRequest) {
  return {
    method: request.method,
    url: request.url?.split("?", 1)[0],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/**
 * The daemon's pino options. pino adds the computer name to every line by
 * default, and it often includes the person's name.
 */
export function daemonLoggerOptions(stream?: { write(line: string): void }) {
  return {
    base: { pid: process.pid },
    serializers: { req: requestLogValue },
    ...(stream ? { stream } : {}),
  };
}
