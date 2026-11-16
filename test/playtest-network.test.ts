import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PlaytestNetwork } from "../src/desktop/playtest-network.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function echoServer(): Promise<{ port: number; closed: () => number }> {
  let closed = 0;
  const server = net.createServer((socket) => {
    socket.on("data", (data) => socket.write(data));
    socket.on("close", () => { closed += 1; });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, closed: () => closed };
}

async function startNetwork(): Promise<{ network: PlaytestNetwork; port: number }> {
  const network = new PlaytestNetwork();
  const rule = await network.listen();
  cleanups.push(() => network.close());
  expect(rule).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
  return { network, port: Number(rule.split(":").at(-1)) };
}

/** Opens a SOCKS5 tunnel the way Chromium does, by IPv4 address or host name; resolves with the proxy's reply code. */
function connectThrough(proxyPort: number, target: { host: string; port: number }): Promise<{ socket: net.Socket; reply: number }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let stage = 0;
    socket.on("error", reject);
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", function onData(data) {
      if (stage === 0) {
        stage = 1;
        const port = Buffer.alloc(2);
        port.writeUInt16BE(target.port);
        const address = net.isIPv4(target.host)
          ? Buffer.from([1, ...target.host.split(".").map(Number)])
          : Buffer.concat([Buffer.from([3, target.host.length]), Buffer.from(target.host)]);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));
        return;
      }
      socket.off("data", onData);
      resolve({ socket, reply: data[1]! });
    });
  });
}

function echo(socket: net.Socket, text: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.write(text);
  });
}

const closedSocket = (socket: net.Socket) => new Promise<void>((resolve) => {
  if (socket.destroyed) resolve();
  else socket.once("close", () => resolve());
});

describe("playtest network", () => {
  it("passes a page's connections through, by address or host name", async () => {
    const target = await echoServer();
    const { port } = await startNetwork();

    const byAddress = await connectThrough(port, { host: "127.0.0.1", port: target.port });
    expect(byAddress.reply).toBe(0);
    expect(await echo(byAddress.socket, "hello")).toBe("hello");
    const byName = await connectThrough(port, { host: "localhost", port: target.port });
    expect(byName.reply).toBe(0);
    expect(await echo(byName.socket, "again")).toBe("again");
    byAddress.socket.destroy();
    byName.socket.destroy();
  });

  it("drops open connections when cut, refuses new ones while offline, and lets them in once restored", async () => {
    const target = await echoServer();
    const { network, port } = await startNetwork();
    const open = await connectThrough(port, { host: "127.0.0.1", port: target.port });
    expect(await echo(open.socket, "before")).toBe("before");

    network.cut();
    // The page sees its connection drop, and so does the server, as a lost network does.
    await closedSocket(open.socket);
    await expect.poll(() => target.closed()).toBe(1);
    const refused = await connectThrough(port, { host: "127.0.0.1", port: target.port });
    expect(refused.reply).toBe(3);
    refused.socket.destroy();

    network.restore();
    const again = await connectThrough(port, { host: "127.0.0.1", port: target.port });
    expect(again.reply).toBe(0);
    expect(await echo(again.socket, "after")).toBe("after");
    again.socket.destroy();
  });

  it("refuses requests it does not serve", async () => {
    const { port } = await startNetwork();
    const socket = net.connect(port, "127.0.0.1");
    socket.on("error", () => {});
    const reply = await new Promise<Buffer>((resolve) => {
      socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
      socket.once("data", () => {
        // BIND instead of CONNECT.
        socket.once("data", resolve);
        socket.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]));
      });
    });
    expect(reply[1]).toBe(7);
    socket.destroy();
  });
});
