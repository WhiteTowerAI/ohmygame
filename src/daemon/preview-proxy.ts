import {
  PREVIEW_CLIENT_QUERY,
  PREVIEW_SOURCE_QUERY,
  previewPagePath,
  type PreviewPageSource,
} from "../shared/preview-page.js";
import {
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import {
  MAX_PREVIEW_DIAGNOSTIC_LENGTH,
  previewDiagnostic,
  type PreviewDiagnostic,
} from "../shared/preview-diagnostics.js";

const BRIDGE_PATH = "/__ohmygame_preview_bridge__.js";
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export interface PreviewProxy {
  url: string;
  close(): Promise<void>;
  reload(): void;
}

/** A separate loopback origin preserves asset paths and HMR without changing project files. */
export async function createPreviewProxy(
  targetUrl: string,
  onDiagnostic: (
    diagnostic?: PreviewDiagnostic,
    diagnostics?: PreviewDiagnostic[],
  ) => void,
  options: {
    port?: number;
    onActivity?: (id: string, active: boolean) => void;
    onNavigation?: (
      client: string,
      source: PreviewPageSource,
      path: string,
    ) => void;
  } = {},
): Promise<PreviewProxy> {
  const target = new URL(targetUrl);
  const failures = new Map<string, PreviewDiagnostic>();
  const sockets = new Set<Socket>();
  const upstreamRequests = new Set<ReturnType<typeof request>>();
  let closed = false;
  let documentId = 0;
  let reloadRevision = 0;
  let origin = "";
  const documents = new Map<
    number,
    { client: string; source: PreviewPageSource; path: string }
  >();
  const clients = new Map<string, number>();
  const resources = new Map<string, number>();
  const reloadStreams = new Map<number, ServerResponse>();
  const closeReloadStream = (document: number) => {
    reloadStreams.get(document)?.end();
    reloadStreams.delete(document);
  };
  const upstreamHeaders = (incoming: IncomingMessage) => {
    const headers = { ...incoming.headers, host: target.host };
    if (headers.origin === origin) headers.origin = target.origin;
    if (headers.referer) {
      const referer = new URL(headers.referer);
      if (referer.origin === origin) {
        referer.searchParams.delete(PREVIEW_CLIENT_QUERY);
        referer.searchParams.delete(PREVIEW_SOURCE_QUERY);
        headers.referer = `${target.origin}${referer.pathname}${referer.search}`;
      }
    }
    return headers;
  };
  const publish = () => {
    const diagnostics = [...failures.values()];
    if (diagnostics.every((item) => !item.client))
      onDiagnostic(diagnostics.at(-1));
    else onDiagnostic(diagnostics.at(-1), diagnostics);
  };
  const clearDiagnostics = (document: number) => {
    const context = documents.get(document);
    if (!context || clients.get(context.client) !== document) return;
    let changed = false;
    for (const key of failures.keys())
      if (key.startsWith(`${context.client}:`)) {
        failures.delete(key);
        changed = true;
      }
    if (changed) publish();
  };
  const report = (
    document: number,
    pathname: string,
    diagnostic?: PreviewDiagnostic,
  ) => {
    const context = documents.get(document);
    if (
      closed ||
      (document > 0 && !context) ||
      (context && clients.get(context.client) !== document)
    )
      return;
    const client = context?.client ?? "default";
    const key = `${client}:${new URL(pathname, target).pathname}`;
    if (diagnostic) {
      failures.set(
        key,
        client === "default"
          ? diagnostic
          : {
              ...diagnostic,
              client,
              source: context?.source,
              path: context?.path,
            },
      );
      if (failures.size > 32) failures.delete(failures.keys().next().value!);
    } else if (!failures.delete(key)) return;
    publish();
  };
  const requestDocument = (incoming: IncomingMessage): number => {
    const url = new URL(incoming.url ?? "/", target);
    const direct = url.searchParams.get(PREVIEW_CLIENT_QUERY);
    if (direct && clients.has(direct)) return clients.get(direct)!;
    const referer = incoming.headers.referer;
    if (referer) {
      const ref = new URL(referer, target);
      const client = ref.searchParams.get(PREVIEW_CLIENT_QUERY);
      if (client && clients.has(client)) return clients.get(client)!;
      const document = resources.get(`${ref.pathname}${ref.search}`);
      if (document !== undefined) return document;
    }
    return documentId;
  };
  const server = createServer((incoming, outgoing) => {
    try {
      if (incoming.url?.split("?")[0] === BRIDGE_PATH) {
        if (
          incoming.method === "GET" &&
          new URL(incoming.url, target).searchParams.get("events") === "1"
        ) {
          const document = Number(
            new URL(incoming.url, target).searchParams.get("document"),
          );
          const context = documents.get(document);
          if (closed || !context || clients.get(context.client) !== document) {
            outgoing.writeHead(404).end();
            return;
          }
          closeReloadStream(document);
          outgoing.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          outgoing.write(
            `data: ${JSON.stringify({ reload: reloadRevision })}\n\n`,
          );
          reloadStreams.set(document, outgoing);
          outgoing.once("close", () => {
            if (reloadStreams.get(document) === outgoing)
              reloadStreams.delete(document);
          });
          return;
        }
        if (incoming.method === "POST") {
          if (incoming.headers.origin !== origin) {
            incoming.resume();
            outgoing.writeHead(403).end();
            return;
          }
          const document = Number(
            new URL(incoming.url, target).searchParams.get("document"),
          );
          void receiveBridgeMessage(incoming)
            .then((message) => {
              const context = documents.get(document);
              if (message.type === "resume" && context)
                clients.set(context.client, document);
              if (
                !closed &&
                context &&
                clients.get(context.client) === document
              ) {
                options.onActivity?.(
                  String(document),
                  message.type !== "close",
                );
                if (message.type === "source" && message.source) {
                  context.source = message.source;
                  for (const diagnostic of failures.values()) {
                    if (diagnostic.client === context.client) diagnostic.source = message.source;
                  }
                  publish();
                }
                if (message.type === "diagnostic") {
                  if (message.diagnostic === null) clearDiagnostics(document);
                  else if (message.diagnostic)
                    report(document, BRIDGE_PATH, message.diagnostic);
                }
                if (
                  typeof message.path === "string" &&
                  message.path.startsWith("/") &&
                  !message.path.startsWith("//") &&
                  message.path.length <= 2_000
                ) {
                  context.path = previewPagePath(message.path);
                  options.onNavigation?.(
                    context.client,
                    context.source,
                    context.path,
                  );
                }
                if (message.type === "close") {
                  clearDiagnostics(document);
                  closeReloadStream(document);
                }
              }
              outgoing
                .writeHead(200, {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                })
                .end(JSON.stringify({ reload: reloadRevision }));
            })
            .catch(() => outgoing.writeHead(400).end());
          return;
        }
        outgoing.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        const document = Number(
          new URL(incoming.url!, target).searchParams.get("document") ??
            documentId,
        );
        outgoing.end(previewBridgeScript(document, documents.get(document)));
        return;
      }
      let document = requestDocument(incoming);
      const incomingUrl = new URL(incoming.url ?? "/", target);
      const requestedPath = `${incomingUrl.pathname}${incomingUrl.search}`;
      incomingUrl.searchParams.delete(PREVIEW_CLIENT_QUERY);
      incomingUrl.searchParams.delete(PREVIEW_SOURCE_QUERY);
      const upstream = request(target, {
        path: `${incomingUrl.pathname}${incomingUrl.search}`,
        method: incoming.method,
        headers: {
          ...upstreamHeaders(incoming),
          "accept-encoding": "identity",
        },
      });
      upstreamRequests.add(upstream);
      upstream.once("close", () => upstreamRequests.delete(upstream));
      incoming.once("aborted", () => upstream.destroy());
      outgoing.once("close", () => {
        if (!outgoing.writableFinished) upstream.destroy();
      });
      upstream.on("error", (error) => {
        if (closed) return;
        report(document, incoming.url ?? "/", {
          kind: "load",
          message: `The preview server could not be reached: ${error.message}`,
        });
        if (!outgoing.headersSent)
          outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end("The preview server could not be reached.");
      });
      upstream.on("response", (response) => {
        response.on("error", () => outgoing.destroy());
        const status = response.statusCode ?? 502;
        const contentType = String(response.headers["content-type"] ?? "");
        const destination = incoming.headers["sec-fetch-dest"];
        if (response.headers.location) {
          try {
            const redirect = new URL(response.headers.location, target);
            if (redirect.origin === target.origin) {
              if (
                !destination ||
                destination === "document" ||
                destination === "iframe"
              ) {
                const client = incomingUrlClient(
                  incoming.url,
                  incoming.headers.referer,
                  target,
                );
                if (client) {
                  redirect.searchParams.set(PREVIEW_CLIENT_QUERY, client);
                  redirect.searchParams.set(
                    PREVIEW_SOURCE_QUERY,
                    new URL(incoming.url ?? "/", target).searchParams.get(
                      PREVIEW_SOURCE_QUERY,
                    ) ??
                      documents.get(document)?.source ??
                      "external",
                  );
                }
              }
              response.headers.location = `${origin}${redirect.pathname}${redirect.search}${redirect.hash}`;
            }
          } catch {
            /* Preserve invalid redirects as project responses. */
          }
        }
        const moduleRequest =
          destination === "script" ||
          /\.(?:[cm]?[jt]sx?|css)(?:\?|$)/i.test(incoming.url ?? "");
        if (
          !moduleRequest &&
          incoming.method === "GET" &&
          contentType.includes("text/html") &&
          (!destination ||
            destination === "document" ||
            destination === "iframe")
        ) {
          const previous = documents.get(document);
          const client =
            incomingUrlClient(incoming.url, incoming.headers.referer, target) ??
            previous?.client ??
            "default";
          const querySource = new URL(
            incoming.url ?? "/",
            target,
          ).searchParams.get(PREVIEW_SOURCE_QUERY);
          const source: PreviewPageSource =
            querySource === "editor" ||
            querySource === "player" ||
            querySource === "playtest" ||
            querySource === "external"
              ? querySource
              : (previous?.source ?? "external");
          const old = clients.get(client);
          if (old !== undefined) {
            clearDiagnostics(old);
            closeReloadStream(old);
            options.onActivity?.(String(old), false);
          }
          document = ++documentId;
          documents.set(document, {
            client,
            source,
            path: previewPagePath(incoming.url ?? "/"),
          });
          clients.set(client, document);
          options.onActivity?.(String(document), true);
          while (documents.size > 64) {
            const oldest = documents.keys().next().value!;
            const oldContext = documents.get(oldest)!;
            clearDiagnostics(oldest);
            closeReloadStream(oldest);
            if (clients.get(oldContext.client) === oldest)
              clients.delete(oldContext.client);
            options.onActivity?.(String(oldest), false);
            documents.delete(oldest);
          }
        }
        resources.set(requestedPath, document);
        if (resources.size > 512)
          resources.delete(resources.keys().next().value!);
        const html =
          contentType.includes("text/html") &&
          incoming.method !== "HEAD" &&
          !response.headers["content-encoding"];
        const failedModule = status >= 500 && (html || moduleRequest);
        if (!html && !failedModule) {
          if (status < 400) report(document, incoming.url ?? "/");
          outgoing.writeHead(status, response.headers);
          response.pipe(outgoing);
          return;
        }
        void relayBuffered(
          incoming,
          outgoing,
          response,
          html,
          failedModule,
          document,
          (diagnostic) => report(document, incoming.url ?? "/", diagnostic),
        ).catch((error) => {
          report(document, incoming.url ?? "/", {
            kind: "load",
            message: `The preview response failed: ${error.message}`,
          });
          outgoing.destroy();
        });
      });
      incoming.pipe(upstream);
    } catch {
      incoming.resume();
      outgoing.writeHead(400).end("Invalid preview request.");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // Vite and other development servers retain their own WebSocket protocols.
  server.on("upgrade", (incoming, socket, head) => {
    try {
      const upstream = request(target, {
        path: incoming.url,
        headers: upstreamHeaders(incoming),
      });
      upstreamRequests.add(upstream);
      upstream.once("close", () => upstreamRequests.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.on("response", () => socket.destroy());
      upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
        sockets.add(upstreamSocket);
        upstreamSocket.once("close", () => {
          sockets.delete(upstreamSocket);
          socket.destroy();
        });
        upstreamSocket.on("error", () => socket.destroy());
        socket.once("close", () => upstreamSocket.destroy());
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(
            response.headers,
          )
            .flatMap(([name, values]) =>
              (Array.isArray(values) ? values : [values]).map(
                (value) => `${name}: ${value}\r\n`,
              ),
            )
            .join("")}\r\n`,
        );
        if (head.length) upstreamSocket.write(head);
        if (upstreamHead.length) socket.write(upstreamHead);
        socket.pipe(upstreamSocket).pipe(socket);
      });
      upstream.end();
    } catch {
      socket.destroy();
    }
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      const fail = (cause: Error) => {
        server.removeListener("listening", ready);
        reject(cause);
      };
      const ready = () => {
        server.removeListener("error", fail);
        resolve();
      };
      server.once("error", fail);
      server.once("listening", ready);
      server.listen(port, "127.0.0.1");
    });
  try {
    await listen(options.port ?? 0);
  } catch (cause) {
    if (!options.port || (cause as NodeJS.ErrnoException).code !== "EADDRINUSE")
      throw cause;
    await listen(0);
  }
  // Consume subsequent errors too; a proxy failure must never kill the daemon.
  server.on("error", (error) => {
    if (!closed) onDiagnostic({ kind: "load", message: error.message });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate preview proxy port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin,
    reload: () => {
      reloadRevision += 1;
      for (const stream of reloadStreams.values())
        stream.write(`data: ${JSON.stringify({ reload: reloadRevision })}\n\n`);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const document of reloadStreams.keys()) closeReloadStream(document);
      for (const document of documents.keys())
        options.onActivity?.(String(document), false);
      for (const upstream of upstreamRequests) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function relayBuffered(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  response: IncomingMessage,
  html: boolean,
  failedModule: boolean,
  document: number,
  report: (diagnostic?: PreviewDiagnostic) => void,
): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    chunks.push(buffer);
    if (size > MAX_HTML_BYTES) {
      // Large pages keep streaming and retain their original representation.
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      for (const buffered of chunks) outgoing.write(buffered);
      for await (const remaining of response) outgoing.write(remaining);
      outgoing.end();
      return;
    }
  }
  const bytes = Buffer.concat(chunks);
  let body = bytes.toString("utf8");
  if (failedModule)
    report({
      kind: "compile",
      message: compilationMessage(body, incoming.url ?? "/"),
    });
  else if ((response.statusCode ?? 502) < 400) report();
  const headers = { ...response.headers };
  if (html) {
    const nonce = body.match(/<script[^>]+nonce=("[^"]*"|'[^']*')/i)?.[1];
    const bridge = `<script ${nonce ? `nonce=${nonce} ` : ""}src="${BRIDGE_PATH}?document=${document}"></script>`;
    body = /<head(?:\s[^>]*)?>/i.test(body)
      ? body.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${bridge}`)
      : `${bridge}${body}`;
    delete headers["content-length"];
    delete headers.etag;
    headers["cache-control"] = "no-store";
  }
  outgoing.writeHead(response.statusCode ?? 502, headers);
  outgoing.end(html ? body : bytes);
}

function compilationMessage(body: string, pathname: string): string {
  // Vite serializes the original diagnostic into its error page.
  const serialized = body.match(/\bconst error = (\{[^\r\n]+\})/);
  try {
    const error = JSON.parse(serialized?.[1] ?? body) as {
      message?: string;
      frame?: string;
      stack?: string;
    };
    if (typeof error.message === "string")
      return [error.message, error.frame]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_PREVIEW_DIAGNOSTIC_LENGTH);
  } catch {}
  return `The preview could not compile ${pathname}. Check the preview's error details and project code.`;
}

type BridgeMessage = {
  type: "heartbeat" | "resume" | "navigation" | "close" | "diagnostic" | "source";
  source?: "editor" | "player";
  path?: string;
  diagnostic?: PreviewDiagnostic | null;
};
async function receiveBridgeMessage(
  incoming: IncomingMessage,
): Promise<BridgeMessage> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_PREVIEW_DIAGNOSTIC_LENGTH * 6 + 2_256)
      throw new Error("Preview report is too large");
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !value ||
    !["heartbeat", "resume", "navigation", "close", "diagnostic", "source"].includes(
      value.type,
    )
  )
    throw new Error("Invalid preview message");
  if (value.type === "source" && value.source !== "editor" && value.source !== "player") throw new Error("Invalid preview source");
  const diagnostic =
    value.diagnostic === null ? null : previewDiagnostic(value.diagnostic);
  if (value.diagnostic !== undefined && diagnostic === undefined)
    throw new Error("Invalid preview diagnostic");
  return {
    type: value.type,
    source: value.type === "source" ? value.source : undefined,
    path:
      typeof value.path === "string" ? value.path.slice(0, 2_000) : undefined,
    diagnostic,
  };
}

function incomingUrlClient(
  value: string | undefined,
  referer: string | undefined,
  base: URL,
): string | undefined {
  const client =
    new URL(value ?? "/", base).searchParams.get(PREVIEW_CLIENT_QUERY) ??
    (referer
      ? new URL(referer, base).searchParams.get(PREVIEW_CLIENT_QUERY)
      : undefined);
  return client && /^[a-zA-Z0-9-]{1,100}$/.test(client) ? client : undefined;
}

function previewBridgeScript(
  documentId: number,
  context?: { client: string; source: PreviewPageSource },
): string {
  return `
(() => {
const limit = ${MAX_PREVIEW_DIAGNOSTIC_LENGTH};
const endpoint = ${JSON.stringify(`${BRIDGE_PATH}?document=${documentId}`)};
const context = ${JSON.stringify(context ?? { client: "default", source: "external" })};
let pending = Promise.resolve();
let revision;
const path = () => {
  const url = new URL(location.href);
  url.searchParams.delete(${JSON.stringify(PREVIEW_CLIENT_QUERY)});
  url.searchParams.delete(${JSON.stringify(PREVIEW_SOURCE_QUERY)});
  url.searchParams.delete('ohmygamePlaytest');
  return url.pathname + url.search + url.hash;
};
const send = (message) => {
  pending = pending.then(async () => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...message, path: path() }) });
    if (!response.ok) return;
    const state = await response.json();
    if (revision !== undefined && revision !== state.reload) location.reload();
    revision = state.reload;
  }).catch(() => {});
  return pending;
};
const preserveContext = (url) => {
  const next = new URL(url || location.href, location.href);
  if (context.client !== 'default' && next.origin === location.origin) {
    next.searchParams.set(${JSON.stringify(PREVIEW_CLIENT_QUERY)}, context.client);
    next.searchParams.set(${JSON.stringify(PREVIEW_SOURCE_QUERY)}, context.source);
  }
  return next.href;
};
const replaceState = history.replaceState.bind(history);
for (const method of ['pushState', 'replaceState']) {
  const original = history[method];
  history[method] = function(state, unused, url) {
    const result = original.call(this, state, unused, preserveContext(url));
    send({ type: 'navigation' });
    return result;
  };
}
history.replaceState(history.state, '', preserveContext(location.href));
window.addEventListener('ohmygame:preview-source', (event) => {
  if (!['editor', 'player'].includes(event.detail) || context.source === event.detail) return;
  context.source = event.detail;
  replaceState(history.state, '', preserveContext(location.href));
  send({ type: 'source', source: context.source });
});
window.addEventListener('popstate', () => send({ type: 'navigation' }));
window.addEventListener('hashchange', () => send({ type: 'navigation' }));
window.addEventListener('pageshow', () => { void send({ type: 'resume' }).then(connectReload); });
window.addEventListener('pagehide', () => navigator.sendBeacon(endpoint, JSON.stringify({ type: 'close' })));
setInterval(() => send({ type: 'heartbeat' }), 20_000);
send({ type: 'heartbeat' });
let reloadEvents;
const connectReload = () => {
  if (reloadEvents && reloadEvents.readyState !== EventSource.CLOSED) return;
  reloadEvents = new EventSource(endpoint + '&events=1');
  reloadEvents.onmessage = (event) => {
    const state = JSON.parse(event.data);
    if (revision !== undefined && revision !== state.reload) location.reload();
    revision = state.reload;
  };
};
connectReload();
window.addEventListener('pagehide', () => reloadEvents?.close());
const text = (error) => String(error?.stack || error?.message || error || 'Unknown preview error').slice(0, limit);
window.addEventListener('error', (event) => {
  if (event.message) send({ type: 'diagnostic', diagnostic: { kind: 'runtime', message: text(event.error || event.message) } });
}, true);
window.addEventListener('unhandledrejection', (event) => send({ type: 'diagnostic', diagnostic: { kind: 'runtime', message: text(event.reason) } }));
const connectVite = () => {
if (document.querySelector('script[src*="/@vite/client"]')) {
  import('/@vite/client').then(({ createHotContext }) => {
    const hot = createHotContext(${JSON.stringify(BRIDGE_PATH)});
    hot.on('vite:error', (event) => send({ type: 'diagnostic', diagnostic: { kind: 'compile', message: text(event.err) } }));
    hot.on('vite:afterUpdate', () => send({ type: 'diagnostic', diagnostic: null }));
  }).catch(() => {});
}
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connectVite, { once: true }); else connectVite();
})();
`;
}
