import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetch as networkFetch, type Dispatcher } from "undici/index.js";
import {
  DEFAULT_NETWORK_SETTINGS,
  NETWORK_TEST_URL,
  type EffectiveNetworkProxy,
  type NetworkConnectionTest,
  type NetworkSettings,
  type NetworkSettingsState,
} from "../shared/network-settings.js";
import {
  createNetworkDispatcher,
  normalizeProxyUrl,
  proxyUrlsFromEnvironment,
  publicNetworkProxy,
  resolveNetworkProxy,
} from "./proxy.js";

export function normalizeNetworkSettings(input: unknown): NetworkSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid network settings");
  const value = input as Partial<NetworkSettings>;
  if (
    !["auto", "manual", "direct"].includes(value.mode ?? "") ||
    typeof value.proxyUrl !== "string" ||
    typeof value.noProxy !== "string"
  )
    throw new Error("Invalid network settings");
  if (value.proxyUrl.length > 2_000 || value.noProxy.length > 4_000)
    throw new Error("Network settings are too long");
  let proxyUrl = "";
  if (value.proxyUrl.trim()) {
    if (value.mode === "manual") proxyUrl = normalizeProxyUrl(value.proxyUrl);
    else {
      try {
        proxyUrl = normalizeProxyUrl(value.proxyUrl);
      } catch {
        /* Discard an invalid inactive draft. */
      }
    }
  }
  if (value.mode === "manual" && !proxyUrl)
    throw new Error("Enter a proxy URL for Manual proxy");
  const noProxy = [
    ...new Set(
      value.noProxy
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].join(",");
  if (/[\r\n;]/.test(noProxy))
    throw new Error("Separate bypass hosts with commas");
  return { mode: value.mode as NetworkSettings["mode"], proxyUrl, noProxy };
}

export class NetworkSettingsStore {
  readonly filePath: string;
  #settings: NetworkSettings = { ...DEFAULT_NETWORK_SETTINGS };
  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, "network-settings.json");
  }

  async load(): Promise<void> {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      if (stored.version !== 1)
        throw new Error("Unsupported network settings version");
      this.#settings = normalizeNetworkSettings(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(): NetworkSettings {
    return { ...this.#settings };
  }

  async update(input: unknown): Promise<NetworkSettings> {
    const settings = normalizeNetworkSettings(input);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      await rename(temporary, this.filePath);
      this.#settings = settings;
    } finally {
      await rm(temporary, { force: true });
    }
    return this.get();
  }
}

export class NetworkSettingsService {
  readonly store: NetworkSettingsStore;
  readonly #environment: NodeJS.ProcessEnv;
  #systemProxy: string | undefined;
  #active: EffectiveNetworkProxy | undefined;
  #loading: Promise<void> | undefined;

  constructor(
    dataDirectory: string,
    private readonly options: {
      environment?: NodeJS.ProcessEnv;
      initialSystemProxy?: string;
      resolveSystemProxy?: () => Promise<string>;
      request?: (
        url: string,
        dispatcher: Dispatcher,
      ) => Promise<{ status: number }>;
    } = {},
  ) {
    this.store = new NetworkSettingsStore(dataDirectory);
    this.#environment = { ...(options.environment ?? {}) };
    this.#systemProxy = options.initialSystemProxy;
  }

  load(): Promise<void> {
    return (this.#loading ??= (async () => {
      await this.store.load();
      this.#active = resolveNetworkProxy(
        this.store.get(),
        this.#environment,
        this.#systemProxy,
      );
    })());
  }

  get(): NetworkSettingsState {
    if (!this.#active) throw new Error("Network settings have not been loaded");
    const settings = this.store.get();
    const detected = resolveNetworkProxy(
      settings,
      this.#environment,
      this.#systemProxy,
    );
    return {
      settings,
      active: publicNetworkProxy(this.#active),
      detected: publicNetworkProxy(detected),
      requiresRestart:
        detected.httpProxy !== this.#active.httpProxy ||
        detected.httpsProxy !== this.#active.httpsProxy ||
        detected.noProxy !== this.#active.noProxy,
      systemProxyAvailable: Boolean(this.options.resolveSystemProxy),
    };
  }

  runtime(): EffectiveNetworkProxy {
    if (!this.#active) throw new Error("Network settings have not been loaded");
    return { ...this.#active };
  }

  async update(input: unknown): Promise<NetworkSettingsState> {
    const settings = normalizeNetworkSettings(input);
    resolveNetworkProxy(settings, this.#environment, this.#systemProxy);
    await this.store.update(settings);
    return this.get();
  }

  async detect(): Promise<NetworkSettingsState> {
    if (this.options.resolveSystemProxy)
      this.#systemProxy = await this.options.resolveSystemProxy();
    return this.get();
  }

  async test(input: unknown): Promise<NetworkConnectionTest> {
    const settings = normalizeNetworkSettings(input);
    const systemProxy =
      settings.mode === "auto" &&
      !proxyUrlsFromEnvironment(this.#environment) &&
      this.options.resolveSystemProxy
        ? await this.options.resolveSystemProxy()
        : this.#systemProxy;
    const route = resolveNetworkProxy(settings, this.#environment, systemProxy);
    const dispatcher = createNetworkDispatcher(route);
    const started = Date.now();
    try {
      const response = await (
        this.options.request ??
        (async (url, connection) => {
          const response = await networkFetch(url, {
            method: "HEAD",
            dispatcher: connection,
            signal: AbortSignal.timeout(10_000),
            redirect: "manual",
          });
          await response.body?.cancel();
          return response;
        })
      )(NETWORK_TEST_URL, dispatcher);
      return {
        reachable: true,
        target: NETWORK_TEST_URL,
        route: publicNetworkProxy(route),
        statusCode: response.status,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      return {
        reachable: false,
        target: NETWORK_TEST_URL,
        route: publicNetworkProxy(route),
        elapsedMs: Date.now() - started,
        error: connectionError(error),
      };
    } finally {
      await dispatcher.destroy();
    }
  }
}

function connectionError(error: unknown): string {
  const cause = error as {
    name?: string;
    code?: string;
    cause?: { code?: string };
  };
  const code = cause?.cause?.code ?? cause?.code;
  if (cause?.name === "TimeoutError" || code?.includes("TIMEOUT"))
    return "The connection timed out. Check the proxy and its routing rules.";
  if (code === "ECONNREFUSED")
    return "The connection was refused. Check that the proxy is running and its port is correct.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return "The hostname could not be resolved. Check the proxy address and DNS settings.";
  if (code?.includes("CERT") || code?.includes("TLS"))
    return "The TLS connection failed. Check the proxy and certificate settings.";
  return "Could not reach api.openai.com. Check the proxy connection and routing rules.";
}
