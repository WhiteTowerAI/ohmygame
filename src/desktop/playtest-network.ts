import net from "node:net";

/**
 * A SOCKS5 proxy for one playtest window, so a plugin can take that
 * player off line and back. Going off line ends every connection it carries,
 * as a dropped network does: the game's server sees its sockets close
 * abnormally, the game sees the same, and new connections are refused until
 * it is on line again. Throttling the page alone isn't enough, because the
 * browser answers WebSocket heartbeats below it.
 */
export class SwitchableProxy {
  readonly #server = net.createServer((client) => this.#accept(client));
  readonly #sockets = new Set<net.Socket>();
  #online = true;

  /** Listens on a free loopback port, and returns it. */
  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    return (this.#server.address() as net.AddressInfo).port;
  }

  get online(): boolean { return this.#online; }

  setOnline(online: boolean): void {
    this.#online = online;
    if (online) return;
    for (const socket of [...this.#sockets]) socket.destroy();
  }

  close(): void {
    this.setOnline(false);
    this.#server.close();
  }

  #track(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }

  #accept(client: net.Socket): void {
    if (!this.#online) {
      client.destroy();
      return;
    }
    this.#track(client);
    client.on("error", () => client.destroy());
    client.once("data", (greeting) => {
      // Version 5, no authentication: Chromium offers nothing else.
      if (greeting[0] !== 5) return client.destroy();
      client.write(Buffer.from([5, 0]));
      client.once("data", (request) => this.#connect(client, request));
    });
  }

  #connect(client: net.Socket, request: Buffer): void {
    const destination = socksDestination(request);
    if (!destination || !this.#online) {
      // Command not supported, or the network went while it was asked for.
      client.end(Buffer.from([5, destination ? 3 : 7, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const upstream = net.connect(destination.port, destination.host);
    this.#track(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    let connected = false;
    upstream.once("connect", () => {
      connected = true;
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      // Connection refused, before anything was piped.
      if (!connected && client.writable) client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      end();
    });
    upstream.once("close", end);
    client.once("close", end);
  }
}

/** Where a SOCKS5 CONNECT request goes, or undefined for any other request. */
export function socksDestination(request: Buffer): { host: string; port: number } | undefined {
  if (request.length < 7 || request[0] !== 5 || request[1] !== 1) return undefined;
  const type = request[3];
  let host: string;
  let offset: number;
  if (type === 1 && request.length >= 10) {
    host = [...request.subarray(4, 8)].join(".");
    offset = 8;
  } else if (type === 3) {
    const length = request[4]!;
    if (request.length < 5 + length + 2) return undefined;
    host = request.subarray(5, 5 + length).toString("utf8");
    offset = 5 + length;
  } else if (type === 4 && request.length >= 22) {
    const words: string[] = [];
    for (let index = 4; index < 20; index += 2) words.push(request.readUInt16BE(index).toString(16));
    host = words.join(":");
    offset = 20;
  } else {
    return undefined;
  }
  return { host, port: request.readUInt16BE(offset) };
}
