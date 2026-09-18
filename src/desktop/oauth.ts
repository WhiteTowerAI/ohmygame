import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

const CALLBACK_PREFIX = "/auth/callback/";

export interface OAuthCallbackServer {
  url: string;
  close: () => Promise<void>;
}

export class OAuthCallbackFlow {
  readonly #notify: () => void;
  #generation = 0;
  #pendingCallback: string | undefined;
  #server: Promise<OAuthCallbackServer> | undefined;

  constructor(notify: () => void) {
    this.#notify = notify;
  }

  async callbackUrl(): Promise<string> {
    if (!this.#server) this.#start();
    return (await this.#server!).url;
  }

  takeCallback(): string | undefined {
    const callback = this.#pendingCallback;
    this.#pendingCallback = undefined;
    return callback;
  }

  async cancel(): Promise<void> {
    this.#generation += 1;
    this.#pendingCallback = undefined;
    const server = this.#server;
    this.#server = undefined;
    if (server) await (await server).close();
  }

  #start(): void {
    const generation = ++this.#generation;
    let server: Promise<OAuthCallbackServer>;
    server = startOAuthCallbackServer((url) => {
      if (generation !== this.#generation) return;
      this.#generation += 1;
      this.#pendingCallback = url;
      if (this.#server === server) this.#server = undefined;
      this.#notify();
      void server.then((activeServer) => activeServer.close()).catch(() => undefined);
    });
    this.#server = server;
    void server.catch(() => {
      if (this.#server === server) this.#server = undefined;
    });
  }
}

export async function startOAuthCallbackServer(onCallback: (url: string) => void): Promise<OAuthCallbackServer> {
  const callbackPath = `${CALLBACK_PREFIX}${randomBytes(24).toString("base64url")}`;
  let completed = false;
  let server: Server;
  server = createServer((request, response) => {
    const callback = callbackUrl(request.url, server, callbackPath);
    if (!callback || completed) {
      response.writeHead(404).end();
      return;
    }
    completed = true;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><meta charset=\"utf-8\"><title>OhMyGame</title><p>Sign-in complete. You can close this window and return to OhMyGame.</p>");
    onCallback(callback);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the OAuth callback server");
  return {
    url: `http://127.0.0.1:${address.port}${callbackPath}`,
    close: () => closeServer(server),
  };
}

export function isOAuthAuthorizationUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function callbackUrl(requestUrl: string | undefined, server: Server, callbackPath: string): string | undefined {
  const address = server.address();
  if (!requestUrl || !address || typeof address === "string") return undefined;
  const url = new URL(requestUrl, `http://127.0.0.1:${address.port}`);
  return url.pathname === callbackPath ? url.href : undefined;
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
