import { EventEmitter } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMultiplayerServer } from "@ohmygame/server";
import { checkClientAddressOptions, clientAddress, trustForwardingHeaders } from "../packages/server/src/client-address.js";

describe("client addresses", () => {
  it("believes forwarding headers only as configured", () => {
    const forged = { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7" };
    // Without trust, the connecting address, whatever the headers say.
    expect(clientAddress(forged, "10.0.0.1", {})).toBe("10.0.0.1");
    expect(clientAddress(forged, "10.0.0.1", { clientIpHeader: "x-real-ip" })).toBe("7.7.7.7");
    // One trusted proxy appended the address it saw; what the client wrote before it does not count.
    expect(clientAddress({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }, "10.0.0.1", { trustProxyHops: 1 })).toBe("203.0.113.9");
    expect(clientAddress({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.1.1.1" }, "10.0.0.1", { trustProxyHops: 2 })).toBe("203.0.113.9");
    expect(clientAddress({}, "10.0.0.1", { trustProxyHops: 1 })).toBe("10.0.0.1");
    expect(() => checkClientAddressOptions({ trustProxyHops: 9 })).toThrow("0 to 5");
    expect(() => checkClientAddressOptions({ clientIpHeader: "x-real-ip", trustProxyHops: 1 })).toThrow("not both");
  });

  it("rewrites a WebSocket upgrade's forwarding headers to the trusted address before Colyseus reads them", () => {
    const server = new EventEmitter() as unknown as Server;
    trustForwardingHeaders(server, {});
    const request = { headers: { "x-forwarded-for": "6.6.6.6", "x-client-ip": "8.8.8.8" }, socket: { remoteAddress: "10.0.0.1" } } as unknown as IncomingMessage;
    server.emit("upgrade", request);
    expect(request.headers).toEqual({ "x-real-ip": "10.0.0.1" });
  });

  it("limits guests per real client, and a forged header buys no more", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-client-address-"));
    const start = async (clientIpHeader?: string) => {
      const service = createMultiplayerServer({
        deployments: [],
        auth: { guestSecret: "a".repeat(32) },
        databasePath: path.join(directory, `${clientIpHeader ?? "direct"}.sqlite`),
        host: "127.0.0.1",
        port: 0,
        allowLocalhost: true,
        logger: false,
        ...(clientIpHeader ? { clientAddress: { clientIpHeader } } : {}),
      });
      await service.start();
      return service;
    };
    const guests = (port: number, headers: (index: number) => Record<string, string>) =>
      Promise.all(Array.from({ length: 21 }, (_, index) =>
        fetch(`http://127.0.0.1:${port}/v1/guests`, { method: "POST", headers: headers(index) }).then((response) => response.status)));
    try {
      const direct = await start();
      // Every forged address is still this one connection's address.
      expect((await guests(direct.port, (index) => ({ "x-forwarded-for": `198.51.100.${index}` }))).filter((status) => status === 429)).toHaveLength(1);
      await direct.stop();
      const proxied = await start("x-real-ip");
      // Behind an ingress, each client its own count.
      expect((await guests(proxied.port, (index) => ({ "x-real-ip": `198.51.100.${index}` }))).every((status) => status === 201)).toBe(true);
      await proxied.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
