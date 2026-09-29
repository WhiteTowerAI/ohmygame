import {
  isPlayableHostMessage,
  type PlayableFrameMessage,
  type PlayableHostMessage,
} from "../shared/playable-player-protocol.js";
import {
  NodeRuntime,
  type PlayableSave,
  type PlayableSaveStore,
} from "../shared/playable-runtime.js";
import { DocumentPlayableSurfaceHost } from "../shared/playable-sandbox.js";

let session: SandboxSession | undefined;

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isPlayableHostMessage(event.data))
    return;
  if (event.data.kind === "ohmygame:playable:save-result") {
    session?.saveStore.resolve(event.data);
    return;
  }
  void startSession(event.data);
});

window.addEventListener("pagehide", () => {
  void disposeSession();
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
    const saveStore = new ParentSaveStore(message.instanceId, message.save);
    const host = new DocumentPlayableSurfaceHost(document);
    const runtime = new NodeRuntime({
      graph: message.definition.graph,
      compiled: message.definition.compiled,
      graphSignature: message.definition.graphSignature,
      surfaceHost: host,
      saveStore,
      assetUrls,
      onError: (error) =>
        post({
          kind: "ohmygame:playable:diagnostic",
          instanceId: message.instanceId,
          error: errorMessage(error),
        }),
    });
    session = {
      instanceId: message.instanceId,
      runtime,
      host,
      saveStore,
      assetUrls,
    };
    await runtime.start();
    post({
      kind: "ohmygame:playable:snapshot",
      instanceId: message.instanceId,
      snapshot: runtime.snapshot(),
    });
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

async function disposeSession(): Promise<void> {
  const current = session;
  session = undefined;
  if (!current) return;
  current.saveStore.dispose();
  await current.runtime.dispose();
  current.host.destroy();
  for (const url of Object.values(current.assetUrls)) URL.revokeObjectURL(url);
}

class ParentSaveStore implements PlayableSaveStore {
  readonly #pending = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  #nextRequest = 0;

  constructor(
    readonly instanceId: string,
    readonly initialSave: unknown,
  ) {}

  async load(): Promise<unknown> {
    return this.initialSave;
  }

  save(save: PlayableSave): Promise<void> {
    const requestId = String(++this.#nextRequest);
    const result = new Promise<void>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    post({
      kind: "ohmygame:playable:save",
      instanceId: this.instanceId,
      requestId,
      save,
    });
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
    else {
      pending.resolve();
      window.setTimeout(() => {
        if (session?.instanceId !== this.instanceId) return;
        post({
          kind: "ohmygame:playable:snapshot",
          instanceId: this.instanceId,
          snapshot: session.runtime.snapshot(),
        });
      }, 0);
    }
  }

  dispose(): void {
    for (const pending of this.#pending.values())
      pending.reject(
        new Error("Published Player closed before the save completed."),
      );
    this.#pending.clear();
  }
}

interface SandboxSession {
  instanceId: string;
  runtime: NodeRuntime;
  host: DocumentPlayableSurfaceHost;
  saveStore: ParentSaveStore;
  assetUrls: Record<string, string>;
}

function post(message: PlayableFrameMessage): void {
  window.parent.postMessage(message, "*");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
