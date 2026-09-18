import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RuntimeModel } from "./agent.js";
import { AccountServiceClient } from "./account-service-client.js";
import type { Model3DSource } from "./managed-3d.js";
import type { VideoSource } from "./seedance-video.js";

const PROVIDER_ID = "ohmygame";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface AccountConnectionState {
  status: "disconnected" | "connecting" | "connected" | "error";
  modelCount?: number;
  error?: string;
}

export class AccountConnection {
  private controller?: AbortController;
  private operation: Promise<unknown> = Promise.resolve();
  private runtimeInstance?: ModelRuntime;
  private registered = false;
  private accountCredential?: { baseUrl: string; apiKey: string };
  private accountAccessToken?: string;
  private accountModelIds: string[] = [];
  private state: AccountConnectionState = { status: "disconnected" };

  constructor(
    private readonly runtime: () => Promise<ModelRuntime>,
    private readonly client: AccountServiceClient,
  ) {}

  get(): AccountConnectionState {
    return this.state;
  }

  connect(accessToken: string): Promise<AccountConnectionState> {
    this.controller?.abort();
    this.accountCredential = undefined;
    this.accountAccessToken = undefined;
    this.accountModelIds = [];
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
        const models = accountModels(runtime.getModels(), ids);
        if (controller.signal.aborted) return this.state;
        this.accountCredential = credential;
        this.accountAccessToken = accessToken;
        this.accountModelIds = ids;
        if (models.length > 0) {
          runtime.registerProvider(PROVIDER_ID, {
            name: "OhMyGame",
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
        this.accountCredential = undefined;
        this.accountAccessToken = undefined;
        this.accountModelIds = [];
        return this.state = { status: "error", error: cause instanceof Error ? cause.message : String(cause) };
      }
    });
  }

  disconnect(): Promise<AccountConnectionState> {
    this.controller?.abort();
    this.controller = undefined;
    this.state = { status: "disconnected" };
    this.accountCredential = undefined;
    this.accountAccessToken = undefined;
    this.accountModelIds = [];
    return this.enqueue(async () => {
      await this.remove();
      return this.state;
    });
  }

  imageSource(): { baseUrl: string; apiKey: string; modelIds: readonly string[] } | undefined {
    if (this.state.status !== "connected" || !this.accountCredential) return undefined;
    return { ...this.accountCredential, modelIds: [...this.accountModelIds] };
  }

  videoSource(): VideoSource | undefined {
    const source = this.imageSource();
    const accessToken = this.accountAccessToken;
    if (!source || !accessToken) return undefined;
    return {
      ...source,
      stageMedia: (reference, signal) => this.client.stageMedia(accessToken, reference, signal),
      removeMedia: (id) => this.client.removeMedia(accessToken, id),
    };
  }

  model3DSource(): Model3DSource | undefined {
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

export function accountModels(catalog: readonly RuntimeModel[], ids: readonly string[]) {
  const matchedModels = ids.flatMap((id) => {
    if (/-image(?:-preview)?$/i.test(id)) return [];
    const matches = catalog.filter((model) => model.provider !== PROVIDER_ID && model.id === id);
    const model = matches.find((candidate) => candidate.provider === "openai")
      ?? (matches.length > 0 && matches.every((candidate) => sameCapabilities(matches[0]!, candidate)) ? matches[0] : undefined);
    return model ? [model] : [];
  });
  return matchedModels.sort((left, right) => catalog.indexOf(right) - catalog.indexOf(left)).map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: ZERO_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

function sameCapabilities(left: RuntimeModel, right: RuntimeModel): boolean {
  return left.reasoning === right.reasoning
    && left.contextWindow === right.contextWindow
    && left.maxTokens === right.maxTokens
    && left.input.join(",") === right.input.join(",");
}
