import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import type {
  DiscoverOpenAIImageModelsRequest,
  DiscoveredOpenAIImageModels,
  OpenAIImageConnectionSettings,
} from "../shared/contracts.js";
import type { ImageSource } from "./image-adapters.js";
import { discoverProviderModels } from "./provider-model-discovery.js";
import { OpenAIImageSettingsStore } from "./openai-image-settings.js";

export function openAIImageConnection(
  store: OpenAIImageSettingsStore,
  runtime: () => Promise<ModelRuntime>,
) {
  const chatSource = async (): Promise<ImageSource | undefined> => {
    const models = await runtime();
    if (!models.hasConfiguredAuth("openai") || models.isUsingOAuth("openai"))
      return undefined;
    const result = await models.getAuth("openai");
    const baseUrl =
      result?.auth.baseUrl ?? models.getProvider("openai")?.baseUrl;
    if (!baseUrl || !result?.auth.apiKey) return undefined;
    return {
      baseUrl,
      apiKey: result.auth.apiKey,
      headers: Object.fromEntries(
        Object.entries(result.auth.headers ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    };
  };
  const source = async (
    input?: DiscoverOpenAIImageModelsRequest,
  ): Promise<ImageSource | undefined> => {
    const settings = input ?? store.get();
    if (settings.mode === "disabled") return undefined;
    return settings.mode === "separate"
      ? store.source(settings.baseUrl, input?.apiKey)
      : chatSource();
  };
  return {
    async get(): Promise<OpenAIImageConnectionSettings> {
      const models = await runtime();
      const connectionAvailable =
        models.hasConfiguredAuth("openai") && !models.isUsingOAuth("openai");
      return {
        ...store.get(),
        connectionAvailable,
        ...(connectionAvailable
          ? { connectionBaseUrl: models.getProvider("openai")?.baseUrl }
          : {}),
      };
    },
    source,
    async resolve() {
      const settings = store.get();
      const models = store.models();
      const imageSource = await source(settings);
      const connected =
        Boolean(imageSource) ||
        (await runtime()
          .then((models) => models.hasConfiguredAuth("openai"))
          .catch(() => false));
      return {
        source: imageSource,
        models,
        connected,
        ...(!imageSource
          ? {
              message:
                settings.mode === "disabled"
                  ? "OpenAI image generation is disabled. Configure an image connection to enable it."
                  : "Browser sign-in does not include image generation. Add an image API key and Base URL in OpenAI settings.",
            }
          : {}),
      };
    },
  };
}

export function registerOpenAIImageRoutes(
  app: FastifyInstance,
  store: OpenAIImageSettingsStore,
  connection: ReturnType<typeof openAIImageConnection>,
  request: typeof fetch = fetch,
) {
  const endpoint = "/settings/models/providers/openai/images";
  app.get(endpoint, () => connection.get());
  app.put(endpoint, async (request, reply) => {
    try {
      if (
        (request.body as { mode?: unknown })?.mode === "connection" &&
        !(await connection.get()).connectionAvailable
      )
        throw new Error(
          "Connect OpenAI chat with an API key, or choose a separate image connection",
        );
      await store.update(request.body);
      return connection.get();
    } catch (cause) {
      return reply.code(400).send({ error: errorMessage(cause) });
    }
  });
  app.delete(endpoint, async () => {
    await store.clear();
    return connection.get();
  });
  app.post<{ Body: DiscoverOpenAIImageModelsRequest }>(
    `${endpoint}/discover`,
    async (incoming, reply) => {
      try {
        const input = incoming.body;
        if (
          !input ||
          !["connection", "separate"].includes(input.mode) ||
          (input.apiKey !== undefined && typeof input.apiKey !== "string")
        )
          throw new Error("Choose an image connection and API key");
        const source = await connection.source(input);
        if (!source)
          throw new Error("Configure an image API key before fetching models");
        const discovered = await discoverProviderModels(
          {
            baseUrl: source.baseUrl,
            api: "openai-completions",
            authentication: "api_key",
            apiKey: source.apiKey,
          },
          (url, init) =>
            request(url, {
              ...init,
              headers: { ...source.headers, ...init?.headers },
            }),
        );
        const models = discovered.models
          .filter((model) => model.usages?.image?.protocol === "openai-images")
          .map((model) => ({
            id: model.id,
            name: model.name,
            template: /^gpt-image-2(?:[.-]|$)/.test(model.id)
              ? ("gpt-image-2" as const)
              : ("gpt-image-1" as const),
            enabled: false,
          }));
        return {
          models,
          ...(discovered.truncated
            ? {
                warnings: [
                  "The model list was truncated. Other IDs can be added manually.",
                ],
              }
            : {}),
        } satisfies DiscoveredOpenAIImageModels;
      } catch (cause) {
        return reply.code(400).send({ error: errorMessage(cause) });
      }
    },
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
