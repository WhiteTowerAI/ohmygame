import {
  isPlayableHostMessage,
  type PlayableFrameMessage,
  type PlayableHostMessage,
  type PlayablePreviewTool,
} from "../shared/playable-player-protocol.js";
import {
  NodeRuntime,
  type PlayablePreferencesStore,
  type PlayableSave,
  type PlayableSaveStore,
  type PlayableSeenStore,
  type PlayableSlotStore,
} from "../shared/playable-runtime.js";
import type { JsonObject } from "../shared/playable-nodes.js";
import type { PlayableSeen } from "../shared/playable-story-map.js";
import { DocumentPlayableAudio } from "../shared/playable-audio.js";
import { reportBackdropMedia, type BackdropMediaReport } from "../shared/playable-media-report.js";
import { DocumentPlayableSurfaceHost, loadPlayableModule } from "../shared/playable-sandbox.js";
import { startPlayablePicking } from "../shared/playable-picking.js";

let session: SandboxSession | undefined;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isPlayableHostMessage(event.data))
    return;
  if (event.data.kind === "ohmygame:playable:save-result") {
    session?.saveStore.resolve(event.data);
    return;
  }
  if (event.data.kind === "ohmygame:playable:pick-start") {
    startPicking(event.data.instanceId, event.data.tool);
    return;
  }
  if (event.data.kind === "ohmygame:playable:pick-cancel") {
    if (session?.instanceId === event.data.instanceId) stopPicking(session);
    return;
  }
  if (event.data.kind === "ohmygame:playable:media-control") {
    if (session?.instanceId === event.data.instanceId && session.preview)
      session.media?.control(event.data.command);
    return;
  }
  void startSession(event.data);
});

window.addEventListener("pagehide", () => {
  void disposeSession();
});

// Exceptions thrown from surface event handlers never pass through a Runtime
// call, so they are recorded here against the current Node.
window.addEventListener("error", (event) => {
  session?.runtime.recordError(event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  session?.runtime.recordError(event.reason);
});

async function startSession(
  message: Extract<PlayableHostMessage, { kind: "ohmygame:playable:init" }>,
): Promise<void> {
  await disposeSession();
  const assetUrls: Record<string, string> = {};
  try {
    for (const [id, asset] of Object.entries(message.assets)) {
      assetUrls[id] = URL.createObjectURL(
        new Blob([asset.bytes], { type: asset.contentType }),
      );
    }
    const saveStore = new ParentSaveStore(message.instanceId, message.save, message.slots);
    const audio = message.preview?.silent ? undefined : new DocumentPlayableAudio(document);
    const host = new DocumentPlayableSurfaceHost(document, loadPlayableModule, audio && ((root) => audio.watchNode(root)), undefined, (error) => post({ kind: "ohmygame:playable:diagnostic", instanceId: message.instanceId, error }));
    const { silent: _silent, ...preview } = message.preview ?? {};
    const runtime = new NodeRuntime({
      graph: message.definition.graph,
      compiled: message.definition.compiled,
      graphSignature: message.definition.graphSignature,
      surfaceHost: host,
      saveStore,
      slotStore: saveStore.slots,
      seenStore: new ParentSeenStore(message.instanceId, message.seen),
      preferencesStore: new ParentPreferencesStore(message.instanceId, message.preferences),
      ...(audio ? { audio } : {}),
      assetUrls,
      ...preview,
      onChange: () => scheduleSnapshot(message.instanceId),
      onError: (error) =>
        post({
          kind: "ohmygame:playable:diagnostic",
          instanceId: message.instanceId,
          error: errorMessage(error),
        }),
    });
    session = {
      instanceId: message.instanceId,
      preview: message.preview !== undefined,
      runtime,
      host,
      saveStore,
      ...(audio ? { audio } : {}),
      assetUrls,
      // The timeline is an authoring tool; published sessions never report media.
      ...(message.preview ? {
        media: reportBackdropMedia(host, (media) => post({ kind: "ohmygame:playable:media", instanceId: message.instanceId, ...(media ? { media } : {}) })),
      } : {}),
    };
    await runtime.start();
    postSnapshot(message.instanceId);
  } catch (cause) {
    if (!session) {
      for (const url of Object.values(assetUrls)) URL.revokeObjectURL(url);
    }
    post({
      kind: "ohmygame:playable:error",
      instanceId: message.instanceId,
      error: errorMessage(cause),
    });
  }
}

function startPicking(instanceId: string, tool: PlayablePreviewTool): void {
  const current = session;
  // Picking is an authoring tool; published sessions never enable it.
  if (current?.instanceId !== instanceId || !current.preview) return;
  stopPicking(current);
  current.picking = startPlayablePicking(current.host.projectRoot, tool, {
    onPick: (pick, additive) => post({ kind: "ohmygame:playable:picked", instanceId, pick, additive }),
    onTextEdit: (edit) => post({ kind: "ohmygame:playable:text-edited", instanceId, edit }),
    onMove: (move) => post({ kind: "ohmygame:playable:moved", instanceId, move }),
    onCancel: () => {
      current.picking = undefined;
      post({ kind: "ohmygame:playable:pick-cancelled", instanceId });
    },
  });
}

function stopPicking(current: SandboxSession): void {
  current.picking?.stop();
  current.picking = undefined;
}

async function disposeSession(): Promise<void> {
  const current = session;
  session = undefined;
  if (!current) return;
  stopPicking(current);
  current.saveStore.dispose();
  current.media?.stop();
  await current.runtime.dispose();
  current.audio?.dispose();
  current.host.destroy();
  for (const url of Object.values(current.assetUrls)) URL.revokeObjectURL(url);
}

/** Keeps the save and the slots with the host, which confirms each write. */
class ParentSaveStore implements PlayableSaveStore {
  readonly #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  #nextRequest = 0;
  readonly slots: PlayableSlotStore;

  constructor(
    readonly instanceId: string,
    readonly initialSave: unknown,
    initialSlots: unknown,
  ) {
    this.slots = {
      load: async () => initialSlots,
      save: (slots) => this.#request((requestId) => ({
        kind: "ohmygame:playable:slots",
        instanceId: this.instanceId,
        requestId,
        slots,
      })),
    };
  }

  async load(): Promise<unknown> {
    return this.initialSave;
  }

  save(save: PlayableSave): Promise<void> {
    return this.#request((requestId) => ({
      kind: "ohmygame:playable:save",
      instanceId: this.instanceId,
      requestId,
      save,
    }));
  }

  #request(message: (requestId: string) => PlayableFrameMessage): Promise<void> {
    const requestId = String(++this.#nextRequest);
    const result = new Promise<void>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    post(message(requestId));
    return result;
  }

  resolve(
    message: Extract<
      PlayableHostMessage,
      { kind: "ohmygame:playable:save-result" }
    >,
  ): void {
    if (message.instanceId !== this.instanceId) return;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return;
    this.#pending.delete(message.requestId);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve();
  }

  dispose(): void {
    for (const pending of this.#pending.values())
      pending.reject(
        new Error("Published Player closed before the save completed."),
      );
    this.#pending.clear();
  }
}

class ParentSeenStore implements PlayableSeenStore {
  constructor(
    readonly instanceId: string,
    readonly initialSeen: unknown,
  ) {}

  async load(): Promise<unknown> {
    return this.initialSeen;
  }

  async save(seen: PlayableSeen): Promise<void> {
    post({ kind: "ohmygame:playable:seen", instanceId: this.instanceId, seen });
  }
}

class ParentPreferencesStore implements PlayablePreferencesStore {
  constructor(
    readonly instanceId: string,
    readonly initialPreferences: unknown,
  ) {}

  async load(): Promise<unknown> {
    return this.initialPreferences;
  }

  async save(preferences: JsonObject): Promise<void> {
    post({ kind: "ohmygame:playable:preferences", instanceId: this.instanceId, preferences });
  }
}

interface SandboxSession {
  instanceId: string;
  preview: boolean;
  runtime: NodeRuntime;
  host: DocumentPlayableSurfaceHost;
  saveStore: ParentSaveStore;
  audio?: DocumentPlayableAudio;
  picking?: { stop: () => void };
  assetUrls: Record<string, string>;
  media?: BackdropMediaReport;
}

let snapshotScheduled = false;

/** Coalesces Runtime changes into one snapshot per task. */
function scheduleSnapshot(instanceId: string): void {
  if (snapshotScheduled) return;
  snapshotScheduled = true;
  window.setTimeout(() => {
    snapshotScheduled = false;
    postSnapshot(instanceId);
  }, 0);
}

function postSnapshot(instanceId: string): void {
  if (session?.instanceId !== instanceId) return;
  post({
    kind: "ohmygame:playable:snapshot",
    instanceId,
    snapshot: session.runtime.snapshot(),
  });
}

function post(message: PlayableFrameMessage): void {
  window.parent.postMessage(message, "*");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
