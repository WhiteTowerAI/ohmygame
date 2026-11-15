/**
 * Owner rooms' pages connected straight to each other over WebRTC. Each page still sends
 * everything through the service, which keeps the room, syncs late arrivals and reaches
 * players a direct connection cannot; where one opens, states and messages also go
 * straight to that player, without the trip to the service or the wait for its tick.
 *
 * Every two players get one connection, set up through the service (p2p.signal): the
 * player with the lower ID offers, the other answers, and both send their network
 * candidates as they find them. A connection carries two channels: states, unordered and
 * never resent, since a newer one follows; and messages, ordered and reliable. One that
 * does not open in time is given up and offered again later.
 *
 * Direct connections reveal each player's network address to the others, so a game turns
 * them on (createMultiplayerClient's p2p option). They open where both players have IPv6,
 * or at least one sits behind a NAT that keeps a port per socket; symmetric NATs on both
 * sides, common on mobile IPv4 and office networks, stay on the service.
 */
import { isRecord } from "./multiplayer-protocol.js";

export type PeerStatus = "connecting" | "open" | "failed";

/** Public STUN servers, which tell a page its public address; both answer from mainland China. */
export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
/** Rooms with more players connect none: every page would hold a connection to each other one. */
export const P2P_MAX_PLAYERS = 8;
/** How long a connection may take to open before it is given up. */
export const P2P_CONNECT_TIMEOUT_MS = 15_000;
/** How long after giving up the offering page tries again. */
export const P2P_RETRY_MS = 60_000;
/** Candidates found within this long go out in one signal, to keep the messages to the service few. */
const CANDIDATE_BATCH_MS = 200;
/** A state channel this far behind skips states rather than queue them: a newer one follows. */
const STATE_BUFFER_LIMIT = 64 * 1024;

export interface PeerOptions {
  iceServers?: RTCIceServer[];
  /** @internal A stand-in for RTCPeerConnection, for tests. */
  peerConnection?: new (configuration: RTCConfiguration) => RTCPeerConnection;
}

export interface PeerHooks {
  /** Sends connection setup to another player through the service. */
  signal(to: string, data: Record<string, unknown>): void;
  playerId(): string | undefined;
  /** A state packet straight from a player. */
  state(from: string, packet: unknown): void;
  /** A message packet straight from a player. */
  message(from: string, packet: unknown): void;
}

interface Peer {
  pc: RTCPeerConnection;
  states: RTCDataChannel;
  messages: RTCDataChannel;
  status: PeerStatus;
  /** Candidates found and not yet sent. */
  outgoing: RTCIceCandidateInit[];
  batch?: ReturnType<typeof setTimeout>;
  /** Candidates that arrived before the other side's description. */
  incoming: RTCIceCandidateInit[];
  timeout: ReturnType<typeof setTimeout>;
}

export class PeerMesh {
  private readonly peers = new Map<string, Peer>();
  /** Players whose connection was given up, and when the offering page may try again. */
  private readonly failed = new Map<string, number>();
  private wanted = new Set<string>();
  private readonly factory?: new (configuration: RTCConfiguration) => RTCPeerConnection;
  private readonly iceServers: RTCIceServer[];

  constructor(
    private readonly hooks: PeerHooks,
    options: PeerOptions = {},
  ) {
    this.factory = options.peerConnection ?? (typeof RTCPeerConnection === "function" ? RTCPeerConnection : undefined);
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
  }

  /** Whether this browser can connect directly at all. */
  get available(): boolean {
    return this.factory !== undefined;
  }

  /** Each other player this page has tried to reach directly, and how that went. */
  status(): Record<string, PeerStatus> {
    const status: Record<string, PeerStatus> = {};
    for (const id of this.failed.keys()) status[id] = "failed";
    for (const [id, peer] of this.peers) status[id] = peer.status;
    return status;
  }

  /** Whether a state or message would reach anyone directly now. */
  get open(): boolean {
    for (const peer of this.peers.values()) if (peer.status === "open") return true;
    return false;
  }

  /** The players in the room now: connects to new ones, drops those gone. */
  update(players: readonly string[]): void {
    const me = this.hooks.playerId();
    if (!this.available || me === undefined) return;
    const others = players.filter((id) => id !== me);
    this.wanted = new Set(others.length < P2P_MAX_PLAYERS ? others : []);
    for (const id of [...this.peers.keys()]) if (!this.wanted.has(id)) this.drop(id);
    for (const id of [...this.failed.keys()]) if (!this.wanted.has(id)) this.failed.delete(id);
    const now = Date.now();
    for (const id of this.wanted)
      if (me < id && !this.peers.has(id) && (this.failed.get(id) ?? 0) <= now) void this.offer(id);
  }

  /** Connection setup another player sent through the service. */
  async receive(from: string, data: unknown): Promise<void> {
    const me = this.hooks.playerId();
    if (!this.available || me === undefined || from === me || !isRecord(data)) return;
    try {
      const description = isRecord(data.description) ? data.description : undefined;
      if (description?.type === "offer" && typeof description.sdp === "string") {
        // The lower ID offers; an offer the other way is a mistake, not a second connection.
        if (me < from || (!this.wanted.has(from) && this.peers.size >= P2P_MAX_PLAYERS - 1)) return;
        // A new offer replaces the connection before it, as when the other page tries again.
        this.drop(from);
        this.failed.delete(from);
        const peer = this.create(from);
        await peer.pc.setRemoteDescription({ type: "offer", sdp: description.sdp });
        await this.addIncoming(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        if (this.peers.get(from) !== peer) return;
        this.hooks.signal(from, { description: { type: "answer", sdp: peer.pc.localDescription!.sdp } });
      } else if (description?.type === "answer" && typeof description.sdp === "string") {
        const peer = this.peers.get(from);
        if (!peer || peer.pc.remoteDescription) return;
        await peer.pc.setRemoteDescription({ type: "answer", sdp: description.sdp });
        await this.addIncoming(peer);
      }
      if (Array.isArray(data.candidates)) {
        const peer = this.peers.get(from);
        if (!peer) return;
        for (const candidate of data.candidates.slice(0, 32)) if (isRecord(candidate)) peer.incoming.push(candidate as RTCIceCandidateInit);
        if (peer.pc.remoteDescription) await this.addIncoming(peer);
      }
    } catch {
      this.fail(from);
    }
  }

  /** Sends a state packet to every player reached directly. */
  sendState(packet: unknown): void {
    this.send("states", packet);
  }

  /** Sends a message packet to every player reached directly. */
  sendMessage(packet: unknown): void {
    this.send("messages", packet);
  }

  close(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.failed.clear();
    this.wanted.clear();
  }

  private send(channel: "states" | "messages", packet: unknown): void {
    let text: string | undefined;
    for (const peer of this.peers.values()) {
      const target = peer[channel];
      if (peer.status !== "open" || target.readyState !== "open") continue;
      if (channel === "states" && target.bufferedAmount > STATE_BUFFER_LIMIT) continue;
      try {
        target.send((text ??= JSON.stringify(packet)));
      } catch {
        /* The channel closed between the check and the send; the connection's own events end it. */
      }
    }
  }

  private async offer(id: string): Promise<void> {
    const peer = this.create(id);
    try {
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      if (this.peers.get(id) !== peer) return;
      this.hooks.signal(id, { description: { type: "offer", sdp: peer.pc.localDescription!.sdp } });
    } catch {
      this.fail(id);
    }
  }

  private create(id: string): Peer {
    const pc = new this.factory!({ iceServers: this.iceServers });
    // Both sides make the same two channels, so neither waits to be told of the other's.
    const states = pc.createDataChannel("states", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const messages = pc.createDataChannel("messages", { negotiated: true, id: 1 });
    const peer: Peer = {
      pc,
      states,
      messages,
      status: "connecting",
      outgoing: [],
      incoming: [],
      timeout: setTimeout(() => peer.status !== "open" && this.fail(id), P2P_CONNECT_TIMEOUT_MS),
    };
    this.peers.set(id, peer);
    pc.onicecandidate = (event) => {
      if (!event.candidate?.candidate || this.peers.get(id) !== peer) return;
      peer.outgoing.push(event.candidate.toJSON());
      peer.batch ??= setTimeout(() => {
        peer.batch = undefined;
        if (this.peers.get(id) !== peer || !peer.outgoing.length) return;
        this.hooks.signal(id, { candidates: peer.outgoing.splice(0) });
      }, CANDIDATE_BATCH_MS);
    };
    const opened = () => {
      if (this.peers.get(id) !== peer || states.readyState !== "open" || messages.readyState !== "open") return;
      peer.status = "open";
      clearTimeout(peer.timeout);
    };
    states.onopen = opened;
    messages.onopen = opened;
    const closed = () => this.peers.get(id) === peer && this.fail(id);
    states.onclose = closed;
    messages.onclose = closed;
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") closed();
    };
    states.onmessage = (event) => this.deliver(id, peer, event, this.hooks.state);
    messages.onmessage = (event) => this.deliver(id, peer, event, this.hooks.message);
    return peer;
  }

  private deliver(id: string, peer: Peer, event: MessageEvent, to: (from: string, packet: unknown) => void): void {
    if (this.peers.get(id) !== peer || typeof event.data !== "string") return;
    let packet: unknown;
    try {
      packet = JSON.parse(event.data);
    } catch {
      return;
    }
    to(id, packet);
  }

  private async addIncoming(peer: Peer): Promise<void> {
    for (const candidate of peer.incoming.splice(0)) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch {
        /* One candidate the browser cannot use does not end the connection. */
      }
    }
  }

  /** Gives up a connection; the offering page tries again after P2P_RETRY_MS. */
  private fail(id: string): void {
    this.drop(id);
    if (this.wanted.has(id)) this.failed.set(id, Date.now() + P2P_RETRY_MS);
  }

  private drop(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timeout);
    clearTimeout(peer.batch);
    for (const channel of [peer.states, peer.messages]) {
      channel.onopen = channel.onclose = channel.onmessage = null;
    }
    peer.pc.onicecandidate = peer.pc.onconnectionstatechange = null;
    peer.pc.close();
  }
}
