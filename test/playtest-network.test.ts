import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { socksDestination, SwitchableProxy } from "../src/desktop/playtest-network.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

/** An echo server standing in for the game's. */
async function echoServer(): Promise<{ port: number; sockets: Set<net.Socket> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { port: (server.address() as net.AddressInfo).port, sockets };
}

/** Connects through the proxy as Chromium does, and returns the socket once the tunnel is up, or the reply code it got. */
function tunnel(proxyPort: number, port: number): Promise<{ socket: net.Socket; reply: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    socket.on("error", reject);
    socket.once("close", () => reject(new Error("closed")));
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.once("data", () => {
      const request = Buffer.from([5, 1, 0, 3, 9, ...Buffer.from("127.0.0.1"), 0, 0]);
      request.writeUInt16BE(port, request.length - 2);
      socket.write(request);
      socket.once("data", (reply) => {
        socket.removeAllListeners("close");
        resolve({ socket, reply: reply[1]! });
      });
    });
  });
}

const echo = (socket: net.Socket, text: string) => new Promise<string>((resolve) => {
  socket.once("data", (data) => resolve(String(data)));
  socket.write(text);
});

describe("a playtest window's proxy", () => {
  it("carries connections, ends them all off line, refuses new ones, and carries them again on line", async () => {
    const server = await echoServer();
    const proxy = new SwitchableProxy();
    closers.push(() => proxy.close());
    const port = await proxy.listen();

    const { socket, reply } = await tunnel(port, server.port);
    expect(reply).toBe(0);
    expect(await echo(socket, "hello")).toBe("hello");

    const closed = new Promise((resolve) => socket.once("close", resolve));
    proxy.setOnline(false);
    await closed;
    // The game's server sees its end go too, as when a player's network drops.
    await expect.poll(() => server.sockets.size).toBe(0);
    await expect(tunnel(port, server.port)).rejects.toThrow();

    proxy.setOnline(true);
    const again = await tunnel(port, server.port);
    expect(await echo(again.socket, "back")).toBe("back");
    again.socket.destroy();
  });

  it("says when the game's server can't be reached", async () => {
    const proxy = new SwitchableProxy();
    closers.push(() => proxy.close());
    const port = await proxy.listen();
    const free = net.createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const unused = (free.address() as net.AddressInfo).port;
    await new Promise((resolve) => free.close(resolve));
    expect((await tunnel(port, unused)).reply).toBe(5);
  });
});

describe("SOCKS5 requests", () => {
  it("reads where a connection goes", () => {
    expect(socksDestination(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90]))).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(socksDestination(Buffer.from([5, 1, 0, 3, 9, ...Buffer.from("localhost"), 0, 80]))).toEqual({ host: "localhost", port: 80 });
    const ipv6 = Buffer.alloc(22);
    ipv6.set([5, 1, 0, 4]);
    ipv6.writeUInt16BE(1, 18);
    ipv6.writeUInt16BE(443, 20);
    expect(socksDestination(ipv6)).toEqual({ host: "0:0:0:0:0:0:0:1", port: 443 });
    // Anything but CONNECT, such as BIND, isn't taken.
    expect(socksDestination(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]))).toBeUndefined();
  });
});
