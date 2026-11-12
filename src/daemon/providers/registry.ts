import type {
  ProviderCapability,
  ProviderSummary,
} from "../../shared/contracts.js";
import type { AudioProviderAdapter } from "../audio-generation.js";

/** One built-in connection a person configures with their own key, as the rest of the daemon sees it. */
export interface MediaProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly ProviderCapability[];
  /** Whether the saved settings are enough to call the service. */
  configured(): boolean;
  /**
   * Forgets the saved credential when the provider is removed; the caller resets its model preferences.
   * A provider without it is disconnected through its own route only.
   */
  clear?(): Promise<void>;
  /** The audio generator this connection contributes. */
  readonly audio?: AudioProviderAdapter;
}

/** The built-in media providers, listed once. Summaries, removal and adapter wiring read from here. */
export class MediaProviderRegistry {
  readonly #entries = new Map<string, MediaProviderEntry>();

  constructor(
    entries: readonly MediaProviderEntry[],
    private readonly enabled: (providerId: string) => boolean,
  ) {
    for (const entry of entries) {
      if (this.#entries.has(entry.id))
        throw new Error(`Provider ${entry.id} is listed twice`);
      this.#entries.set(entry.id, entry);
    }
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get(id: string): MediaProviderEntry | undefined {
    return this.#entries.get(id);
  }

  configured(id: string): boolean {
    return this.#entry(id).configured();
  }

  /** Whether removing the provider goes through this list. */
  removable(id: string): boolean {
    return Boolean(this.#entries.get(id)?.clear);
  }

  async clear(id: string): Promise<void> {
    await this.#entry(id).clear?.();
  }

  /** The same summary shape for every entry, in registration order. */
  summaries(): ProviderSummary[] {
    return [...this.#entries.values()].map((entry) => {
      const configured = entry.configured();
      return {
        id: entry.id,
        name: entry.name,
        configured,
        enabled: this.enabled(entry.id),
        custom: false,
        status: configured ? "connected" : "not_configured",
        methods: [{ type: "api_key", label: `${entry.name} API key` }],
        credentialType: "api_key",
        capabilities: [...entry.capabilities],
      };
    });
  }

  /** Every audio adapter, in registration order; the order decides the catalog order. */
  audioAdapters(): AudioProviderAdapter[] {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.audio ? [entry.audio] : [],
    );
  }

  #entry(id: string): MediaProviderEntry {
    const entry = this.#entries.get(id);
    if (!entry)
      throw new Error(`Provider ${id} is not a built-in media provider`);
    return entry;
  }
}
