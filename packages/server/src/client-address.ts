import type { IncomingHttpHeaders, IncomingMessage, Server } from "node:http";

/**
 * Where requests really come from, for per-address limits. Behind a reverse proxy every
 * connection comes from the proxy, so the service must read the client from a header the
 * proxy writes; and it must never believe such a header from anyone else, or a client could
 * name any address it likes.
 */
export interface ClientAddressOptions {
  /**
   * A header the ingress overwrites with the connecting address, such as x-real-ip on
   * Railway. Set it only when clients cannot reach the service without that ingress.
   */
  clientIpHeader?: string;
  /**
   * The number of trusted proxies in front of the service that append to
   * X-Forwarded-For; the client is the address the outermost of them saw. 0 or unset
   * trusts none.
   */
  trustProxyHops?: number;
}

const FORWARDING_HEADERS = ["x-real-ip", "x-forwarded-for", "x-client-ip"];

export function checkClientAddressOptions(options: ClientAddressOptions): void {
  if (options.clientIpHeader !== undefined && !/^[a-z0-9-]{1,64}$/i.test(options.clientIpHeader))
    throw new Error("clientIpHeader must be a header name.");
  if (options.trustProxyHops !== undefined && (!Number.isInteger(options.trustProxyHops) || options.trustProxyHops < 0 || options.trustProxyHops > 5))
    throw new Error("trustProxyHops must be a whole number from 0 to 5.");
  if (options.clientIpHeader && options.trustProxyHops)
    throw new Error("Set clientIpHeader or trustProxyHops, not both.");
}

/** The client's address for a request, by the configured trust; the connection's own otherwise. */
export function clientAddress(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  options: ClientAddressOptions,
): string {
  const read = (name: string) => {
    const value = headers[name.toLowerCase()];
    return (Array.isArray(value) ? value.join(",") : value)?.trim() || undefined;
  };
  if (options.clientIpHeader) {
    const value = read(options.clientIpHeader)?.split(",")[0]?.trim();
    if (value) return value.slice(0, 64);
  } else if (options.trustProxyHops) {
    const hops = read("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
    // Each trusted proxy appends the address it saw; untrusted entries come before them.
    const client = hops[hops.length - options.trustProxyHops];
    if (client) return client.slice(0, 64);
  }
  return socketAddress ?? "unknown";
}

/**
 * Colyseus reads a WebSocket client's address from forwarding headers without asking
 * whom to trust. Before it does, this rewrites them on every upgrade to the address the
 * service trusts, so limits keyed by context.ip cannot be dodged with a forged header.
 */
export function trustForwardingHeaders(server: Server, options: ClientAddressOptions): void {
  server.prependListener("upgrade", (request: IncomingMessage) => {
    const address = clientAddress(request.headers, request.socket.remoteAddress, options);
    for (const name of FORWARDING_HEADERS) delete request.headers[name];
    request.headers["x-real-ip"] = address;
  });
}
