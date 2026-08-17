import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  ModelAuthEvent,
  ModelAuthMethod,
  ModelAuthNotification,
  ModelAuthPrompt,
  ModelProviderSummary,
} from "../shared/contracts.js";

type PiInteraction = Parameters<ModelRuntime["login"]>[2];
type PiPrompt = Parameters<PiInteraction["prompt"]>[0];
type PiNotification = Parameters<PiInteraction["notify"]>[0];

interface PendingPrompt {
  id: string;
  secret: boolean;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

interface AuthOperation {
  id: string;
  providerId: string;
  method: ModelAuthMethod;
  controller: AbortController;
  events: ModelAuthEvent[];
  subscribers: Set<(event: ModelAuthEvent) => void>;
  pending?: PendingPrompt;
  finished: boolean;
}

type NewModelAuthEvent = ModelAuthEvent extends infer Event
  ? Event extends ModelAuthEvent ? Omit<Event, "id" | "operationId"> : never
  : never;

export class ModelAuthManager {
  readonly #operations = new Map<string, AuthOperation>();

  constructor(private readonly getRuntime: () => Promise<ModelRuntime>) {}

  async providers(): Promise<ModelProviderSummary[]> {
    const runtime = await this.getRuntime();
    const credentials = new Map((await runtime.listCredentials()).map((credential) => [credential.providerId, credential.type]));
    return runtime.getProviders().flatMap((provider) => {
      const methods: ModelProviderSummary["methods"] = [];
      if (provider.auth.oauth) {
        methods.push({ type: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
      }
      if (provider.auth.apiKey?.login) {
        methods.push({ type: "api_key", label: provider.auth.apiKey.name });
      }
      const status = runtime.getProviderAuthStatus(provider.id);
      if (!status.configured && methods.length === 0) return [];
      const credentialType = credentials.get(provider.id);
      return [{
        id: provider.id,
        name: provider.name,
        configured: status.configured,
        ...(status.label ? { source: status.label } : {}),
        ...(credentialType ? { credentialType } : {}),
        methods,
      }];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  async start(providerId: string, method: ModelAuthMethod): Promise<string> {
    this.#prune();
    const runtime = await this.getRuntime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new ModelAuthError("Model provider not found", 404);
    if (method === "oauth" && !provider.auth.oauth) throw new ModelAuthError("OAuth is not available for this provider", 400);
    if (method === "api_key" && !provider.auth.apiKey?.login) throw new ModelAuthError("API key setup is not available for this provider", 400);

    const operation: AuthOperation = {
      id: randomUUID(),
      providerId,
      method,
      controller: new AbortController(),
      events: [],
      subscribers: new Set(),
      finished: false,
    };
    this.#operations.set(operation.id, operation);
    const interaction: PiInteraction = {
      signal: operation.controller.signal,
      notify: (notification) => this.#publish(operation, {
        type: "notification",
        notification: publicNotification(notification),
      }),
      prompt: (prompt) => this.#prompt(operation, prompt),
    };
    void runtime.login(providerId, method, interaction).then(
      () => this.#finish(operation, { type: "completed" }),
      (error) => this.#finish(operation, operation.controller.signal.aborted
        ? { type: "cancelled" }
        : { type: "error", error: errorMessage(error) }),
    );
    return operation.id;
  }

  eventsSince(operationId: string, cursor: number): ModelAuthEvent[] {
    const operation = this.#operation(operationId);
    return operation.events.filter((event) => event.id > cursor);
  }

  subscribe(operationId: string, listener: (event: ModelAuthEvent) => void): () => void {
    const operation = this.#operation(operationId);
    operation.subscribers.add(listener);
    return () => operation.subscribers.delete(listener);
  }

  respond(operationId: string, promptId: string, value: string): void {
    const operation = this.#operation(operationId);
    if (!operation.pending || operation.pending.id !== promptId) throw new ModelAuthError("Authentication prompt is no longer active", 409);
    if (operation.method === "api_key" && operation.pending.secret && !/^[\x21-\x7E]+$/.test(value.trim())) {
      throw new ModelAuthError("API key must contain only printable ASCII characters", 400);
    }
    const pending = operation.pending;
    operation.pending = undefined;
    pending.resolve(operation.method === "api_key" ? value.trim() : value);
  }

  cancel(operationId: string): void {
    const operation = this.#operation(operationId);
    if (operation.finished) return;
    operation.controller.abort(new Error("Authentication cancelled"));
    operation.pending?.reject(new Error("Authentication cancelled"));
    operation.pending = undefined;
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.getRuntime();
    if (!runtime.getProvider(providerId)) throw new ModelAuthError("Model provider not found", 404);
    await runtime.logout(providerId);
  }

  close(): void {
    for (const operation of this.#operations.values()) {
      if (!operation.finished) this.cancel(operation.id);
    }
  }

  #prompt(operation: AuthOperation, prompt: PiPrompt): Promise<string> {
    if (operation.finished || operation.controller.signal.aborted) return Promise.reject(new Error("Authentication cancelled"));
    if (operation.pending) return Promise.reject(new Error("Authentication already has an active prompt"));
    const promptId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      operation.pending = { id: promptId, secret: prompt.type === "secret", resolve, reject };
      this.#publish(operation, { type: "prompt", promptId, prompt: publicPrompt(prompt) });
      prompt.signal?.addEventListener("abort", () => {
        if (operation.pending?.id !== promptId) return;
        operation.pending = undefined;
        reject(new Error("Authentication prompt cancelled"));
      }, { once: true });
    });
  }

  #publish(operation: AuthOperation, event: NewModelAuthEvent): void {
    if (operation.finished) return;
    const published = { ...event, id: operation.events.length + 1, operationId: operation.id } as ModelAuthEvent;
    operation.events.push(published);
    for (const subscriber of operation.subscribers) subscriber(published);
  }

  #finish(operation: AuthOperation, event: NewModelAuthEvent): void {
    if (operation.finished) return;
    operation.pending = undefined;
    this.#publish(operation, event);
    operation.finished = true;
  }

  #operation(id: string): AuthOperation {
    const operation = this.#operations.get(id);
    if (!operation) throw new ModelAuthError("Authentication operation not found", 404);
    return operation;
  }

  #prune(): void {
    if (this.#operations.size < 32) return;
    for (const [id, operation] of this.#operations) {
      if (operation.finished) this.#operations.delete(id);
    }
    if (this.#operations.size >= 32) throw new ModelAuthError("Too many authentication operations", 429);
  }
}

export class ModelAuthError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

function publicPrompt(prompt: PiPrompt): ModelAuthPrompt {
  if (prompt.type === "select") {
    return { type: prompt.type, message: prompt.message, options: prompt.options.map((option) => ({ ...option })) };
  }
  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
  };
}

function publicNotification(notification: PiNotification): ModelAuthNotification {
  if (notification.type === "info") {
    return {
      type: notification.type,
      message: notification.message,
      ...(notification.links ? { links: notification.links.map((link) => ({ ...link })) } : {}),
    };
  }
  return { ...notification };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
