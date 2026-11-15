import { randomUUID } from "node:crypto";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import {
  describeProtocolMismatch,
  isMultiplayerManifestConfig,
  isRecord,
  MULTIPLAYER_PROTOCOL_UNSUPPORTED_CODE,
  multiplayerRoomType,
  negotiateProtocolVersion,
  sameMultiplayerConfig,
  type MultiplayerManifestConfig,
} from "@ohmygame/sdk/protocol";
import { MultiplayerAuth, type MultiplayerAuthOptions } from "./auth.js";
import { RoomStore, type StoredRoom } from "./store.js";
import { GameRoom, ROOM_IDLE_MS, ROUND_RESTART_MS, type RoomIdentity } from "./turn-room.js";
import { resolveGameAdapter, type GameAdapter } from "./adapters.js";
import { mountGameData, type GameDataOptions } from "./game-data-routes.js";
import { HOST_MESSAGE_MAX_BYTES } from "@ohmygame/sdk/host";
import { createLocalAccounts, mountGameDataViewer } from "./local-accounts.js";
import { checkClientAddressOptions, clientAddress, trustForwardingHeaders, type ClientAddressOptions } from "./client-address.js";
import { deploymentFor, isDeploymentRequest, type DeploymentRegistrationOptions } from "./deployment-registration.js";
import { MemoryGameDataStore } from "./game-data.js";

export interface MultiplayerServerOptions {
  deployments: MultiplayerManifestConfig[];
  auth: MultiplayerAuthOptions;
  databasePath: string;
  host?: string;
  port?: number;
  publicAddress?: string;
  maxRooms?: number;
  logger?: boolean;
  allowLocalhost?: boolean;
  adapters?: Record<string, GameAdapter>;
  /** Pause between drop-in rounds; tests shorten it. */
  roundRestartMs?: number;
  /** Cloud saves and leaderboards. Without it the service offers rooms only. */
  gameData?: GameDataOptions;
  /**
   * Local development only, with allowLocalhost: a stand-in account service where anyone
   * signs in as a test player, and a page per game showing its saves and leaderboards at
   * /dev/games/:gameId. See local-accounts.ts.
   */
  localAccounts?: boolean;
  /**
   * How to find a request's real client behind a reverse proxy, for per-address limits.
   * Without it the service uses the connecting address and ignores forwarding headers.
   */
  clientAddress?: ClientAddressOptions;
  /**
   * Lets publishers register their games' deployments at publish time, kept with the
   * rooms. Without it only the deployments given here exist.
   */
  registration?: DeploymentRegistrationOptions;
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
  if (options.allowLocalhost && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error("Local multiplayer must listen on a loopback address.");
  if (!Number.isInteger(maxRooms) || maxRooms < 1)
    throw new Error("maxRooms must be a positive integer.");
  const deployments = new Map<string, MultiplayerManifestConfig>();
  for (const config of options.deployments) {
    if (
      !isMultiplayerManifestConfig(config, { allowLocalhost: options.allowLocalhost }) ||
      deployments.has(multiplayerRoomType(config))
    )
      throw new Error("Invalid or duplicate multiplayer deployment.");
    deployments.set(multiplayerRoomType(config), config);
    resolveGameAdapter(config, options.adapters);
  }
  if (options.localAccounts && !options.allowLocalhost) throw new Error("Local test accounts are only for a local service.");
  const localAccounts = options.localAccounts ? createLocalAccounts() : undefined;
  const addressing = options.clientAddress ?? {};
  checkClientAddressOptions(addressing);
  const clientOf = (request: { headers: import("node:http").IncomingHttpHeaders; socket: { remoteAddress?: string } }) =>
    clientAddress(request.headers, request.socket.remoteAddress, addressing);
  const auth = new MultiplayerAuth({ ...options.auth, ...(localAccounts ? { localAccountKey: localAccounts.publicKey } : {}) });
  const store = new RoomStore(options.databasePath);
  if (options.registration && !isMultiplayerManifestConfig(deploymentFor("check", { mode: "turn-based", adapterId: "host", maxClients: 2, roomPolicy: "invite-or-public", reconnectSeconds: 60 }, options.registration.publicUrl)))
    throw new Error("The registration publicUrl must be this service's HTTPS origin.");
  // Deployments publishers registered come back after a restart, like their rooms.
  for (const config of store.deployments()) {
    const key = multiplayerRoomType(config);
    if (deployments.has(key)) continue;
    try {
      resolveGameAdapter(config, options.adapters);
      deployments.set(key, config);
    } catch (cause) {
      console.error(`A registered deployment no longer has its rules: ${key}`, cause);
    }
  }
  store.prune(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const restoring = new Map<string, StoredRoom>();
  const rate = new RateLimit();
  const activeRooms = new Set<string>();
  const transport = new WebSocketTransport({
    // A hosting player's answers carry the room's state, and its views for each seat.
    maxPayload: HOST_MESSAGE_MAX_BYTES + 16 * 1024,
    pingInterval: 10_000,
    pingMaxRetries: 3,
    beforeUpgrade: (_request, context) =>
      rate.take(`ws:${context.ip ?? "unknown"}`, 60)
        ? undefined
        : new Response("Too many connections", { status: 429 }),
  });
  // Upgrades carry the client address the service trusts, which the limit above reads.
  if (transport.server) trustForwardingHeaders(transport.server, addressing);
  let draining = false;
  let pruneGameData: (() => Promise<void>) | undefined;
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
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "OPTIONS") {
          response.sendStatus(204);
          return;
        }
        // The client's address by the configured trust, never by a header the client chose.
        if (!rate.take(`http:${clientOf(request)}`, 240)) {
          response.status(429).json({ error: "Too many requests." });
          return;
        }
        if (draining && request.method !== "GET") {
          response.status(503).json({ error: "The service is restarting." });
          return;
        }
        next();
      });
      // Saves take larger bodies than room requests, so their routes parse their own.
      if (options.gameData) pruneGameData = mountGameData(app, options.gameData, auth, rate).prune;
      app.use(express.json({ limit: "16kb" }));
      localAccounts?.mount(app);
      if (options.allowLocalhost && options.gameData?.store instanceof MemoryGameDataStore)
        mountGameDataViewer(app, options.gameData.store);
      app.get("/healthz", (_request, response) =>
        response.status(draining ? 503 : 200).json({ ok: !draining }),
      );
      app.post("/v1/guests", (request, response) => {
        if (!rate.take(`guest:${clientOf(request)}`, 20)) {
          response.status(429).json({ error: "Too many guest sessions." });
          return;
        }
        // A returning guest sends their old token and stays the same guest.
        response.status(201).json(auth.issueGuest(bearer(request.headers.authorization)));
      });
      // A publisher registers the deployment their published game names.
      app.post("/v1/games/:gameId/deployments", async (request, response) => {
        const registration = options.registration;
        if (!registration) {
          response.status(404).json({ error: "This service does not take registrations." });
          return;
        }
        const gameId = String(request.params.gameId);
        const token = bearer(request.headers.authorization);
        const body = request.body as unknown;
        if (!isDeploymentRequest(body) || !/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) {
          response.status(400).json({ error: "Send mode, adapterId, maxClients, roomPolicy and reconnectSeconds, and tickMs for a lockstep deployment." });
          return;
        }
        if (!rate.take(`register:${clientOf(request)}`, 20)) {
          response.status(429).json({ error: "Too many registrations." });
          return;
        }
        try {
          if (!token || !(await registration.verifyOwner(gameId, token))) {
            response.status(403).json({ error: "Only the game's publisher may register its deployments." });
            return;
          }
        } catch {
          response.status(503).json({ error: "The service cannot check the game's publisher right now. Try again shortly." });
          return;
        }
        const config = deploymentFor(gameId, body, registration.publicUrl);
        const key = multiplayerRoomType(config);
        const existing = deployments.get(key);
        if (existing) {
          response.json(existing);
          return;
        }
        if (store.deploymentCount(gameId) >= (registration.maxPerGame ?? 50)) {
          response.status(409).json({ error: "This game has registered its most deployments." });
          return;
        }
        try {
          if (!isMultiplayerManifestConfig(config)) throw new Error("The deployment settings are invalid.");
          resolveGameAdapter(config, options.adapters);
        } catch (cause) {
          response.status(400).json({ error: publicError(cause) });
          return;
        }
        store.saveDeployment(key, config);
        deployments.set(key, config);
        defineDeployment(config);
        response.status(201).json(config);
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
              ip: clientOf(request),
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
          await auth.authenticate(bearer(request.headers.authorization), config);
          if (!rate.take(`resolve:${clientOf(request)}`, 30)) {
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
          const identity = await auth.authenticate(bearer(request.headers.authorization), config);
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
  /** Rules a local playtest registered with its deployment, by room type. */
  const localAdapters = new Map<string, GameAdapter>();
  function defineDeployment(config: MultiplayerManifestConfig) {
    class DeploymentRoom extends GameRoom {
      protected services = {
        config,
        store,
        restoring,
        // Read when each room opens, so a local playtest's reloaded rules reach new rooms.
        adapter: localAdapters.get(multiplayerRoomType(config)) ?? resolveGameAdapter(config, options.adapters),
        reserve: (roomId: string) => {
          if (activeRooms.size >= maxRooms) return false;
          activeRooms.add(roomId);
          return true;
        },
        roundRestartMs: options.roundRestartMs ?? ROUND_RESTART_MS,
        ...(options.gameData ? { results: { store: options.gameData.store, allowGame: options.gameData.allowGame } } : {}),
      };
      static async onAuth(token: string, value: unknown) {
        if (
          !isRecord(value) ||
          value.gameId !== config.gameId ||
          value.deploymentId !== config.deploymentId
        )
          throw new Error("The game deployment does not match.");
        const protocolVersion = negotiateProtocolVersion(value);
        if (protocolVersion === undefined)
          throw Object.assign(new Error(describeProtocolMismatch(value)), { code: MULTIPLAYER_PROTOCOL_UNSUPPORTED_CODE });
        const identity = await auth.authenticate(token, config);
        if (!rate.take(`player:${identity.userId}`, 60))
          throw new Error("Too many room requests.");
        // A reconnection keeps the auth, so the room speaks the same version to it again.
        return { ...identity, protocolVersion } satisfies RoomIdentity;
      }
    }
    server
      .define(multiplayerRoomType(config), DeploymentRoom)
      // Quick play fills the fullest open room first, so players gather instead of spreading out.
      .sortBy({ clients: -1 })
      .on("dispose", (room) => activeRooms.delete(room.roomId));
  }
  for (const config of deployments.values()) defineDeployment(config);
  let started = false;
  let closed = false;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  return {
    server,
    host,
    /**
     * Local testing only. adapter is the game's own rules for config.adapterId; registering
     * the same deployment again with new rules applies them to rooms opened afterwards.
     */
    registerLocalDeployment(config: MultiplayerManifestConfig, adapter?: GameAdapter) {
      if (!options.allowLocalhost || !isMultiplayerManifestConfig(config, { allowLocalhost: true }))
        throw new Error("Dynamic registration is only available for local testing.");
      const key = multiplayerRoomType(config);
      const previous = deployments.get(key);
      if (previous && !sameMultiplayerConfig(previous, config)) throw new Error("A deployment is immutable. Use a new deployment ID.");
      // Checks the seats and mode the same way as a deployment registered at startup.
      resolveGameAdapter(config, adapter ? { ...options.adapters, [config.adapterId ?? ""]: adapter } : options.adapters);
      if (adapter) localAdapters.set(key, adapter);
      if (previous) return;
      deployments.set(key, config);
      defineDeployment(config);
    },
    get port(): number {
      const address = transport.server?.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async start() {
      if (started) return;
      await server.listen(port, host);
      started = true;
      if (pruneGameData) {
        void pruneGameData();
        pruneTimer = setInterval(() => void pruneGameData!(), 60 * 60 * 1000);
        pruneTimer.unref();
      }
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
      if (closed) return;
      closed = true;
      draining = true;
      clearInterval(pruneTimer);
      if (started) {
        await server.gracefullyShutdown(false);
        started = false;
      }
      store.close();
      await options.gameData?.store.close();
    },
  };
}
function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}
function publicError(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The room request failed.";
}
