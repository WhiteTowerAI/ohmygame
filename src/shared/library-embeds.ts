// Pages a Library source's results may show in their details, such as a 3D
// viewer: only from the sites the source's plugin asks to connect to.

/**
 * The sites a plugin's results may show pages from: the hosts it asks to
 * connect to, on the standard https port. The person saw them when allowing it.
 */
export function libraryEmbedHosts(network: readonly string[] | undefined): string[] {
  return [...new Set((network ?? []).flatMap((entry) => {
    const [host, port] = entry.split(":");
    return host && (port === undefined || port === "443") ? [host] : [];
  }))];
}

/**
 * A result's page to embed, when it is an https page, without credentials,
 * on one of the source's hosts; anything else is left out, and the result
 * still shows.
 */
export function embedOf(value: string, hosts: readonly string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) return undefined;
  return url.href;
}

/** The origin of an https page to embed, or nothing for anything else. */
export function embedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a frame of the window may go from `from` to `to`. A frame showing
 * one of the `embedded` origins stays on it, so the page can't become another
 * site inside the app. Other frames are left to their own rules.
 */
export function embedNavigationAllowed(from: string, to: string, embedded: ReadonlySet<string>): boolean {
  let origin: string;
  try {
    origin = new URL(from).origin;
  } catch {
    return true;
  }
  if (!embedded.has(origin)) return true;
  try {
    return new URL(to).origin === origin;
  } catch {
    return false;
  }
}
