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
