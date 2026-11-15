/**
 * A stand-in for RTCPeerConnection in one process: two connections link once each has
 * both descriptions and a candidate from the other, and their negotiated channels then
 * pass messages to each other. `reachable = false` keeps every connection from opening,
 * as behind two symmetric NATs.
 */
export class FakePeerConnection {
  static reachable = true;
  static readonly all = new Map<string, FakePeerConnection>();
  static reset(): void {
    FakePeerConnection.reachable = true;
    FakePeerConnection.all.clear();
  }

  readonly id = Math.random().toString(36).slice(2);
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: { candidate: { candidate: string; toJSON(): RTCIceCandidateInit } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channels = new Map<number, FakeChannel>();
  private remoteId?: string;
  private gotCandidate = false;

  constructor(readonly configuration: RTCConfiguration) {
    FakePeerConnection.all.set(this.id, this);
  }
  createDataChannel(label: string, options: RTCDataChannelInit): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.set(options.id!, channel);
    return channel;
  }
  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `fake ${this.id}` };
  }
  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `fake ${this.id}` };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = description;
    setTimeout(() => {
      const candidate = `candidate:${this.id} 1 udp 1 203.0.113.1 4000 typ srflx`;
      this.onicecandidate?.({ candidate: { candidate, toJSON: () => ({ candidate, sdpMid: "0" }) } });
      this.onicecandidate?.({ candidate: null });
    }, 1);
    this.link();
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description;
    this.remoteId = description.sdp!.split(" ")[1];
    this.link();
  }
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (candidate.candidate?.includes(this.remoteId ?? "?")) this.gotCandidate = true;
    this.link();
  }
  close(): void {
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    FakePeerConnection.all.delete(this.id);
    for (const channel of this.channels.values()) channel.end();
  }
  private ready(): boolean {
    return !!this.localDescription && !!this.remoteDescription && this.gotCandidate && this.connectionState !== "closed";
  }
  private link(): void {
    const other = this.remoteId ? FakePeerConnection.all.get(this.remoteId) : undefined;
    if (!FakePeerConnection.reachable || !other || !this.ready() || !other.ready() || this.connectionState === "connected") return;
    for (const [pc, peer] of [[this, other], [other, this]] as const) {
      pc.connectionState = "connected";
      for (const [id, channel] of pc.channels) channel.peer = peer.channels.get(id);
    }
    setTimeout(() => {
      for (const pc of [this, other]) for (const channel of pc.channels.values()) channel.start();
    }, 1);
  }
}

export class FakeChannel {
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  peer?: FakeChannel;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  constructor(readonly label: string) {}
  send(data: string): void {
    if (this.readyState !== "open") throw new Error("not open");
    this.sent.push(data);
    const peer = this.peer;
    setTimeout(() => peer?.readyState === "open" && peer.onmessage?.({ data }), 0);
  }
  start(): void {
    if (this.readyState !== "connecting") return;
    this.readyState = "open";
    this.onopen?.();
  }
  end(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
    this.peer?.end();
  }
}
