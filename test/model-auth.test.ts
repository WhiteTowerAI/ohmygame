import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ModelAuthManager } from "../src/daemon/model-auth.js";

describe("model provider authentication", () => {
  it("derives providers and methods from Pi", async () => {
    const manager = new ModelAuthManager(async () => runtime({ configured: true, credentialType: "oauth" }));

    expect(await manager.providers()).toEqual([{
      id: "test-provider",
      name: "Test Provider",
      configured: true,
      source: "OAuth",
      credentialType: "oauth",
      methods: [
        { type: "oauth", label: "Sign in with Test" },
        { type: "api_key", label: "Test API key" },
      ],
    }]);
  });

  it("bridges prompts and completion without exposing credentials", async () => {
    const login = vi.fn(async (_providerId: string, _method: string, interaction: PiInteraction) => {
      interaction.notify({ type: "progress", message: "Preparing" });
      const key = await interaction.prompt({ type: "secret", message: "API key" });
      expect(key).toBe("secret-value");
      return { type: "api_key", key };
    });
    const manager = new ModelAuthManager(async () => runtime({ login }));

    const operationId = await manager.start("test-provider", "api_key");
    await tick();
    const prompt = manager.eventsSince(operationId, 0).find((event) => event.type === "prompt");
    expect(prompt).toMatchObject({ type: "prompt", prompt: { type: "secret", message: "API key" } });
    if (!prompt || prompt.type !== "prompt") throw new Error("Prompt was not emitted");

    manager.respond(operationId, prompt.promptId, "secret-value");
    await tick();

    const events = manager.eventsSince(operationId, 0);
    expect(events.map((event) => event.type)).toEqual(["notification", "prompt", "completed"]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("gives Pi the installation's device ID for sign-in", async () => {
    const login = vi.fn(async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }));
    const onCredentialsChanged = vi.fn(async () => undefined);
    const manager = new ModelAuthManager(async () => runtime({ login }), {
      getDeviceId: () => "9b2f5c1e-4d7a-4f8e-9c3b-2a1d6e5f4c3b",
      onCredentialsChanged,
    });

    await manager.start("test-provider", "oauth");
    await tick();

    const options = (login.mock.calls[0] as unknown[] | undefined)?.[3] as { getDeviceId?: () => string } | undefined;
    expect(options?.getDeviceId?.()).toBe("9b2f5c1e-4d7a-4f8e-9c3b-2a1d6e5f4c3b");
    expect(onCredentialsChanged).toHaveBeenCalledOnce();
    manager.close();
  });

  it("marks the GitHub Copilot enterprise domain prompt as optional", async () => {
    const login = vi.fn(async (_providerId: string, _method: string, interaction: PiInteraction) => {
      await interaction.prompt({ type: "text", message: "Enterprise domain" });
      return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
    });
    const manager = new ModelAuthManager(async () => runtime({ providerId: "github-copilot", login }));

    const operationId = await manager.start("github-copilot", "oauth");
    await tick();

    expect(manager.eventsSince(operationId, 0)).toContainEqual(expect.objectContaining({
      type: "prompt",
      prompt: expect.objectContaining({ type: "text", optional: true }),
    }));
    manager.close();
  });

  it("uses Pi logout for stored credentials", async () => {
    const logout = vi.fn(async () => undefined);
    const manager = new ModelAuthManager(async () => runtime({ logout }));

    await manager.logout("test-provider");

    expect(logout).toHaveBeenCalledWith("test-provider");
  });

  it("rejects API keys that cannot be used in an authorization header", async () => {
    const login = vi.fn(async (_providerId: string, _method: string, interaction: PiInteraction) => {
      await interaction.prompt({ type: "secret", message: "API key" });
      return { type: "api_key", key: "unused" };
    });
    const manager = new ModelAuthManager(async () => runtime({ login }));
    const operationId = await manager.start("test-provider", "api_key");
    await tick();
    const prompt = manager.eventsSince(operationId, 0).find((event) => event.type === "prompt");
    if (!prompt || prompt.type !== "prompt") throw new Error("Prompt was not emitted");

    expect(() => manager.respond(operationId, prompt.promptId, "帮助我配置")).toThrow("printable ASCII");
  });
});

type PiInteraction = Parameters<ModelRuntime["login"]>[2];

function runtime(options: {
  providerId?: string;
  configured?: boolean;
  credentialType?: "api_key" | "oauth";
  login?: (...args: any[]) => Promise<any>;
  logout?: (...args: any[]) => Promise<any>;
} = {}): ModelRuntime {
  const provider = {
    id: options.providerId ?? "test-provider",
    name: "Test Provider",
    auth: {
      oauth: { name: "Test OAuth", loginLabel: "Sign in with Test" },
      apiKey: { name: "Test API key", login: vi.fn() },
    },
  };
  return {
    getProviders: () => [provider],
    getProvider: (id: string) => id === provider.id ? provider : undefined,
    getProviderAuthStatus: () => ({ configured: options.configured ?? false, label: options.configured ? "OAuth" : undefined }),
    listCredentials: async () => options.credentialType ? [{ providerId: provider.id, type: options.credentialType }] : [],
    login: options.login ?? vi.fn(),
    logout: options.logout ?? vi.fn(),
  } as unknown as ModelRuntime;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
