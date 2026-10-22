import { randomUUID } from "node:crypto";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  isMultiplayerManifestConfig,
  isRecord,
  multiplayerRoomType,
  sameMultiplayerConfig,
  type MultiplayerManifestConfig,
} from "../shared/multiplayer-protocol.js";
import { MultiplayerAuth, type MultiplayerAuthOptions } from "./auth.js";
import { RoomStore, type StoredRoom } from "./store.js";
import { GameRoom, ROOM_IDLE_MS } from "./turn-room.js";

export interface MultiplayerServerOptions {
  deployments: MultiplayerManifestConfig[];
  auth: MultiplayerAuthOptions;
  databasePath: string;
  host?: string;
  port?: number;
  publicAddress?: string;
  maxRooms?: number;
  logger?: boolean;
}

/** Fixed windows are bounded and also used for WebSocket upgrades. */
class RateLimit {
  private readonly entries = new Map<
    string,
    { count: number; until: number }
  >();
  take(key: string, limit: number): boolean {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 10_000) {
        for (const [id, item] of this.entries)
          if (item.until <= now) this.entries.delete(id);
        if (this.entries.size >= 10_000) return false;
      }
      entry = { count: 0, until: now + 60_000 };
      this.entries.set(key, entry);
    }
    return ++entry.count <= limit;
  }
}

export function createMultiplayerServer(options: MultiplayerServerOptions) {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 43130;
  const maxRooms = options.maxRooms ?? 100;
  if (!Number.isInteger(maxRooms) || maxRooms < 1)
    throw new Error("maxRooms must be a positive integer.");
  const deployments = new Map<string, MultiplayerManifestConfig>();
  for (const config of options.deployments) {
    if (
      !isMultiplayerManifestConfig(config) ||
      deployments.has(multiplayerRoomType(config))
    )
      throw new Error("Invalid or duplicate multiplayer deployment.");
    deployments.set(multiplayerRoomType(config), config);
  }
  const auth = new MultiplayerAuth(options.auth);
  const store = new RoomStore(options.databasePath);
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const restoring = new Map<string, StoredRoom>();
  const rate = new RateLimit();
  const activeRooms = new Set<string>();
  const transport = new WebSocketTransport({
    maxPayload: 16 * 1024,
    pingInterval: 10_000,
    pingMaxRetries: 3,
    beforeUpgrade: (_request, context) =>
      rate.take(`ws:${context.ip ?? "unknown"}`, 60)
        ? undefined
        : new Response("Too many connections", { status: 429 }),
  });
  let draining = false;
  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
    ...(options.publicAddress ? { publicAddress: options.publicAddress } : {}),
    ...(options.logger === false ? { logger: false } : {}),
    express(app) {
      app.use((request, response, next) => {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, OPTIONS",
        );
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "OPTIONS") {
          response.sendStatus(204);
          return;
        }
        // Use the actual peer address. A reverse proxy must impose its own per-IP limit.
        if (!rate.take(`http:${request.socket.remoteAddress}`, 240)) {
          response.status(429).json({ error: "Too many requests." });
          return;
        }
        if (draining && request.method === "POST") {
          response.status(503).json({ error: "The service is restarting." });
          return;
        }
        next();
      });
      app.use(express.json({ limit: "16kb" }));
      app.get("/healthz", (_request, response) =>
        response.status(draining ? 503 : 200).json({ ok: !draining }),
      );
      app.post("/v1/guests", (request, response) => {
        if (!rate.take(`guest:${request.socket.remoteAddress}`, 20)) {
          response.status(429).json({ error: "Too many guest sessions." });
          return;
        }
        response.status(201).json(auth.issueGuest());
      });
      app.get(
        "/v1/games/:gameId/deployments/:deploymentId",
        (request, response) => {
          const config = deployments.get(multiplayerRoomType(request.params));
          if (!config) {
            response.status(404).json({ error: "Deployment not found." });
            return;
          }
          response.json(config);
        },
      );
      app.get("/v1/games/:gameId/rooms", async (request, response) => {
        const config = deployments.get(
          multiplayerRoomType({
            gameId: request.params.gameId,
            deploymentId: String(request.query.deploymentId ?? ""),
          }),
        );
        if (!config) {
          response.status(404).json({ error: "Deployment not found." });
          return;
        }
        if (config.roomPolicy === "invite-only") {
          response.json([]);
          return;
        }
        const rooms = await matchMaker.query({
          name: multiplayerRoomType(config),
          locked: false,
          private: false,
        });
        response.json(
          rooms.slice(0, 100).map((room) => ({
            roomId: room.roomId,
            clients: room.clients,
            maxClients: room.maxClients,
          })),
        );
      });
      app.post("/v1/games/:gameId/rooms", async (request, response) => {
        const body = request.body as unknown;
        const config =
          isRecord(body) && typeof body.deploymentId === "string"
            ? deployments.get(
                multiplayerRoomType({
                  gameId: request.params.gameId,
                  deploymentId: body.deploymentId,
                }),
              )
            : undefined;
        if (!config || !isRecord(body)) {
          response.status(400).json({ error: "Unknown game deployment." });
          return;
        }
        try {
          const reservation = await matchMaker.create(
            multiplayerRoomType(config),
            body,
            {
              token: bearer(request.headers.authorization),
              headers: new Headers(),
              ip: request.socket.remoteAddress,
            },
          );
          response.status(201).json(reservation);
        } catch (cause) {
          response.status(403).json({ error: publicError(cause) });
        }
      });
      app.post("/v1/rooms/resolve", async (request, response) => {
        const body = request.body as unknown;
        if (
          !isRecord(body) ||
          typeof body.gameId !== "string" ||
          typeof body.deploymentId !== "string" ||
          typeof body.roomCode !== "string"
        ) {
          response.status(400).json({ error: "Invalid invitation." });
          return;
        }
        const config = deployments.get(
          multiplayerRoomType({
            gameId: body.gameId,
            deploymentId: body.deploymentId,
          }),
        );
        if (!config) {
          response.status(404).json({ error: "Room not found." });
          return;
        }
        try {
          await auth.authenticate(
            bearer(request.headers.authorization),
            config.authPolicy,
          );
          if (!rate.take(`resolve:${request.socket.remoteAddress}`, 30)) {
            response
              .status(429)
              .json({ error: "Too many invitation attempts." });
            return;
          }
          for (const room of await matchMaker.query({
            name: multiplayerRoomType(config),
          })) {
            if (
              await matchMaker.remoteRoomCall(room.roomId, "matchesInvite", [
                body.roomCode,
              ])
            ) {
              response.json({ roomId: room.roomId });
              return;
            }
          }
          response.status(404).json({ error: "Room not found." });
        } catch {
          response
            .status(403)
            .json({ error: "A valid player token is required." });
        }
      });
      app.get("/v1/rooms/:roomId/snapshot", async (request, response) => {
        try {
          const room = await matchMaker
            .query({ roomId: request.params.roomId })
            .then((rooms) => rooms[0]);
          const config = room && deployments.get(room.name);
          if (!config) {
            response.status(404).json({ error: "Room not found." });
            return;
          }
          const identity = await auth.authenticate(
            bearer(request.headers.authorization),
            config.authPolicy,
          );
          response.json(
            await matchMaker.remoteRoomCall(
              room!.roomId,
              "authorizedSnapshot",
              [identity.userId],
            ),
          );
        } catch {
          response.status(403).json({ error: "Room membership is required." });
        }
      });
    },
  });
  for (const config of deployments.values()) {
    class DeploymentRoom extends GameRoom {
      protected services = {
        config,
        store,
        restoring,
        reserve: (roomId: string) => {
          if (activeRooms.size >= maxRooms) return false;
          activeRooms.add(roomId);
          return true;
        },
      };
      static async onAuth(token: string, value: unknown) {
        if (
          !isRecord(value) ||
          value.gameId !== config.gameId ||
          value.deploymentId !== config.deploymentId ||
          value.protocolVersion !== 1
        )
          throw new Error("The game deployment or protocol does not match.");
        const identity = await auth.authenticate(token, config.authPolicy);
        if (!rate.take(`player:${identity.userId}`, 60))
          throw new Error("Too many room requests.");
        return identity;
      }
    }
    server
      .define(multiplayerRoomType(config), DeploymentRoom)
      .on("dispose", (room) => activeRooms.delete(room.roomId));
  }
  let started = false;
  return {
    server,
    host,
    get port(): number {
      const address = transport.server?.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async start() {
      if (started) return;
      await server.listen(port, host);
      started = true;
      for (const record of store.rooms()) {
        if (record.snapshot.state.phase === "closed") continue;
        const config = deployments.get(multiplayerRoomType(record.config));
        if (!config || !sameMultiplayerConfig(config, record.config))
          throw new Error(
            "A saved deployment was removed or changed. Keep immutable deployment entries until their rooms expire.",
          );
        if (
          record.config.mode === "realtime" ||
          Date.now() - record.updatedAt > ROOM_IDLE_MS
        ) {
          record.snapshot.state.phase = "closed";
          record.snapshot.sequence++;
          record.snapshot.serverTime = new Date().toISOString();
          store.save(record);
        } else {
          if (activeRooms.size >= maxRooms)
            throw new Error(
              "The room limit is lower than the number of rooms to restore.",
            );
          const restoreToken = randomUUID();
          restoring.set(restoreToken, record);
          await matchMaker.createRoom(multiplayerRoomType(config), {
            restoreToken,
          });
        }
      }
    },
    async stop() {
      draining = true;
      if (started) {
        await server.gracefullyShutdown(false);
        started = false;
      }
      store.close();
    },
  };
}
function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}
function publicError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The room request failed.";
}
