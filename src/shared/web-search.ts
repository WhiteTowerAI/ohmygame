export type WebSearchProvider = "auto" | "exa" | "parallel" | "custom";

export interface WebSearchCustomProviderSettings {
  name: string;
  endpoint: string;
  toolName: string;
  apiKeyConfigured: boolean;
}

export interface WebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKeyConfigured: boolean;
  parallelApiKeyConfigured: boolean;
  custom?: WebSearchCustomProviderSettings;
}

export interface UpdateWebSearchSettings {
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKey?: string | null;
  parallelApiKey?: string | null;
  custom?: {
    name: string;
    endpoint: string;
    toolName: string;
    apiKey?: string | null;
  };
}

export interface WebSearchInput {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

export interface WebSearchExecution {
  content: string;
  provider: Exclude<WebSearchProvider, "auto">;
  providerName: string;
  fallbackFrom?: Exclude<WebSearchProvider, "auto">;
}
export type WebSearchToolMetadata = Pick<
  WebSearchExecution,
  "provider" | "providerName" | "fallbackFrom"
>;
