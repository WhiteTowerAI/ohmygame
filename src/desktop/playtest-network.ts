import net from "node:net";

const SOCKS_VERSION = 5;
const REPLY_SUCCEEDED = 0;
const REPLY_NETWORK_UNREACHABLE = 3;
const REPLY_COMMAND_UNSUPPORTED = 7;
const REPLY_ADDRESS_UNSUPPORTED = 8;
/** A greeting or request bigger than this is not a browser's. */
const MAX_HANDSHAKE_BYTES = 600;

/**
 * One playtest page's network: a SOCKS5 proxy on loopback that the page's
 * session sends everything through, so `cut` can drop the page's open
 * connections, WebSockets included, and refuse new ones until `restore`.
 * Chromium's offline emulation and closing a session's connections leave
 * open WebSockets running, which is what a multiplayer game uses.
 */
export class PlaytestNetwork {
  readonly #tunnels = new Set<{ client: net.Socket; upstream?: net.Socket }>();
  readonly #server = net.createServer((client) => this.#accept(client));
  #offline = false;

  /** Starts the proxy; returns the rule for the page's session. */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address() as net.AddressInfo;
    return `socks5://127.0.0.1:${address.port}`;
  }

  get offline(): boolean {
    return this.#offline;
  }

  /** Drops every open connection, as a lost network would, and refuses new ones. */
  cut(): void {
    this.#offline = true;
    for (const tunnel of [...this.#tunnels]) this.#drop(tunnel);
  }

  restore(): void {
    this.#offline = false;
  }

  close(): void {
    this.cut();
    if (this.#server.listening) this.#server.close();
  }

  #accept(client: net.Socket): void {
    const tunnel: { client: net.Socket; upstream?: net.Socket } = { client };
    this.#tunnels.add(tunnel);
    client.on("error", () => this.#drop(tunnel));
    client.on("close", () => this.#drop(tunnel));
    let buffered = Buffer.alloc(0);
    let greeted = false;
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HANDSHAKE_BYTES) return this.#drop(tunnel);
      if (!greeted) {
        // Version, method count, methods: only "no authentication" is offered back.
        if (buffered.length < 2) return;
        const length = 2 + buffered[1]!;
        if (buffered.length < length) return;
        if (buffered[0] !== SOCKS_VERSION) return this.#drop(tunnel);
        buffered = buffered.subarray(length);
        greeted = true;
        client.write(Buffer.from([SOCKS_VERSION, 0]));
      }
      const request = parseRequest(buffered);
      if (request === "incomplete") return;
      client.off("data", onData);
      if (request === "unsupported-command") return this.#refuse(tunnel, REPLY_COMMAND_UNSUPPORTED);
      if (request === "unsupported-address") return this.#refuse(tunnel, REPLY_ADDRESS_UNSUPPORTED);
      if (this.#offline) return this.#refuse(tunnel, REPLY_NETWORK_UNREACHABLE);
      const rest = buffered.subarray(request.length);
      const upstream = net.connect(request.port, request.host);
      tunnel.upstream = upstream;
      upstream.on("error", () => this.#drop(tunnel));
      upstream.on("close", () => this.#drop(tunnel));
      upstream.once("connect", () => {
        if (!this.#tunnels.has(tunnel)) return;
        client.write(Buffer.from([SOCKS_VERSION, REPLY_SUCCEEDED, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on("data", onData);
  }

  #refuse(tunnel: { client: net.Socket }, reply: number): void {
    tunnel.client.end(Buffer.from([SOCKS_VERSION, reply, 0, 1, 0, 0, 0, 0, 0, 0]));
  }

  #drop(tunnel: { client: net.Socket; upstream?: net.Socket }): void {
    if (!this.#tunnels.delete(tunnel)) return;
    tunnel.client.destroy();
    tunnel.upstream?.destroy();
  }
}

type SocksRequest = { host: string; port: number; length: number } | "incomplete" | "unsupported-command" | "unsupported-address";

/** A SOCKS5 CONNECT request: version, command, reserved, address type, address, port. */
function parseRequest(data: Buffer): SocksRequest {
  if (data.length < 5) return "incomplete";
  if (data[0] !== SOCKS_VERSION || data[1] !== 1) return "unsupported-command";
  let host: string;
  let offset: number;
  switch (data[3]) {
    case 1:
      offset = 8;
      if (data.length < offset + 2) return "incomplete";
      host = [...data.subarray(4, 8)].join(".");
      break;
    case 3: {
      offset = 5 + data[4]!;
      if (data.length < offset + 2) return "incomplete";
      host = data.subarray(5, offset).toString("utf8");
      break;
    }
    case 4: {
      offset = 20;
      if (data.length < offset + 2) return "incomplete";
      const parts: string[] = [];
      for (let index = 4; index < 20; index += 2) parts.push(data.readUInt16BE(index).toString(16));
      host = parts.join(":");
      break;
    }
    default:
      return "unsupported-address";
  }
  return { host, port: data.readUInt16BE(offset), length: offset + 2 };
}
