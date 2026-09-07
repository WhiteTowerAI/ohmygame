import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "./agent.js";
import { PortalClient } from "./portal-client.js";
import type { VideoSource } from "./minimax-video.js";

const PROVIDER_ID = "opengame";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface PortalConnectionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  modelCount?: number;
  error?: string;
}

export class PortalConnection {
  private controller?: AbortController;
  private operation: Promise<unknown> = Promise.resolve();
  private runtimeInstance?: ModelRuntime;
  private registered = false;
  private portalCredential?: { baseUrl: string; apiKey: string };
  private portalModelIds: string[] = [];
  private state: PortalConnectionState = { status: "disconnected" };

  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly client: PortalClient,
  ) {}

  get(): PortalConnectionState {
    return this.state;
  }

  connect(accessToken: string): Promise<PortalConnectionState> {
    this.controller?.abort();
    this.portalCredential = undefined;
    this.portalModelIds = [];
    const controller = new AbortController();
    this.controller = controller;
    this.state = { status: "connecting" };
    return this.enqueue(async () => {
      try {
        if (controller.signal.aborted) return this.state;
        const runtime = this.runtimeInstance ??= await this.runtime();
        await this.remove();
        if (controller.signal.aborted) return this.state;
        const credential = await this.client.credential(accessToken, controller.signal);
        const ids = await this.client.modelIds(credential, controller.signal);
        const models = portalModels(runtime.getModels(), ids);
        if (controller.signal.aborted) return this.state;
        this.portalCredential = credential;
        this.portalModelIds = ids;
        if (models.length > 0) {
          runtime.registerProvider(PROVIDER_ID, {
            name: "OpenGame Portal",
            baseUrl: credential.baseUrl,
            api: "openai-responses",
            authHeader: true,
            models,
          });
          this.registered = true;
          await runtime.setRuntimeApiKey(PROVIDER_ID, credential.apiKey);
        }
        if (controller.signal.aborted) {
          await this.remove();
          return this.state;
        }
        return this.state = { status: "connected", modelCount: models.length };
      } catch (cause) {
        if (this.registered) await this.remove();
        if (controller.signal.aborted) return this.state;
        this.portalCredential = undefined;
        this.portalModelIds = [];
        return this.state = { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
      }
    });
  }

  disconnect(): Promise<PortalConnectionState> {
    this.controller?.abort();
    this.controller = undefined;
    this.state = { status: "disconnected" };
    this.portalCredential = undefined;
    this.portalModelIds = [];
    return this.enqueue(async () => {
      await this.remove();
      return this.state;
    });
  }

  imageSource(): { baseUrl: string; apiKey: string; modelIds: readonly string[] } | undefined {
    if (this.state.status !== "connected" || !this.portalCredential) return undefined;
    return { ...this.portalCredential, modelIds: [...this.portalModelIds] };
  }

  videoSource(): VideoSource | undefined {
    return this.imageSource();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result;
    return result;
  }

  private async remove(): Promise<void> {
    if (!this.registered || !this.runtimeInstance) return;
    try {
      await this.runtimeInstance.removeRuntimeApiKey(PROVIDER_ID);
    } finally {
      this.runtimeInstance.unregisterProvider(PROVIDER_ID);
      this.registered = false;
    }
  }
}

export function portalModels(catalog: readonly RuntimeModel[], ids: readonly string[]) {
  return ids.flatMap((id) => {
    if (/-image(?:-preview)?$/i.test(id)) return [];
    const matches = catalog.filter((model) => model.provider !== PROVIDER_ID && model.id === id);
    const model = matches.find((candidate) => candidate.provider === "openai")
      ?? (matches.length > 0 && matches.every((candidate) => sameCapabilities(matches[0]!, candidate)) ? matches[0] : undefined);
    if (!model) return [];
    return [{
      id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: ZERO_COST,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }];
  });
}

function sameCapabilities(left: RuntimeModel, right: RuntimeModel): boolean {
  return left.reasoning === right.reasoning
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.input.join(",") === right.input.join(",");
}
