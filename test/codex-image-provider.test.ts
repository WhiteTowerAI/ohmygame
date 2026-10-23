import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_IMAGE_MODEL,
  CodexImageProvider,
} from "../src/daemon/agent-runtimes/codex-image-provider.js";
import { setAgentProcessSpawner } from "../src/daemon/agent-runtimes/process.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { IMAGE_MAX_REFERENCE_IMAGES } from "../src/shared/contracts.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
afterEach(async () => {
  setAgentProcessSpawner(undefined);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Message = { id: number; method: string; params: Record<string, any> };
function fakeServer(
  options: {
    noImage?: boolean;
    failed?: boolean;
    hold?: string;
    onTurn?: (message: Message) => Promise<void>;
  } = {},
) {
  const calls: Message[] = [];
  const closed = vi.fn();
  setAgentProcessSpawner(((
    _binary: string,
    _args: string[],
    settings: { cwd: string },
  ) => {
    const child = new EventEmitter() as any;
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    Object.assign(child, {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill: () => true,
    });
    const send = (message: unknown) =>
      stdout.write(`${JSON.stringify(message)}\n`);
    stdin.on("finish", () => {
      child.exitCode = 0;
      stdout.end();
      closed(settings.cwd);
      child.emit("close", 0, null);
    });
    readline.createInterface({ input: stdin }).on("line", (line) => {
      const message = JSON.parse(line) as Message;
      calls.push(message);
      if (message.method === options.hold || message.method === "initialized")
        return;
      let result: unknown = {};
      if (message.method === "config/read")
        result = { config: { mcp_servers: { external: {} } } };
      if (message.method === "thread/start")
        result = {
          thread: { id: "image-thread" },
          activePermissionProfile: { id: "ohmygame-image" },
        };
      send({ id: message.id, result });
      if (message.method === "turn/start")
        void (async () => {
          await options.onTurn?.(message);
          if (!options.noImage) {
            const params = {
              threadId: "image-thread",
              item: {
                id: "image-1",
                type: "imageGeneration",
                status: "completed",
                result: png.toString("base64"),
              },
            };
            send({ method: "item/completed", params });
            send({ method: "item/completed", params });
          }
          send({
            method: "turn/completed",
            params: {
              threadId: "image-thread",
              turn: {
                status: options.failed ? "failed" : "completed",
                error: { message: "Account limit reached" },
              },
            },
          });
        })().catch((cause: unknown) =>
          send({
            method: "turn/completed",
            params: {
              threadId: "image-thread",
              turn: { status: "failed", error: { message: String(cause) } },
            },
          }),
        );
    });
    return child;
  }) as never);
  return { calls, closed };
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "ohmygame-codex-images-"));
  roots.push(root);
  const connection = {
    path: "/fake/codex",
    source: "path" as const,
    signature: "codex-1",
    env: { CODEX_HOME: root },
    auth: { status: "signed-in" as const, billing: "subscription" as const },
    version: "0.163.0",
    error: undefined,
  };
  const connect = vi.fn(async () => connection);
  return {
    root,
    connection,
    connect,
    provider: new CodexImageProvider(root, connect),
  };
}

describe("Codex CLI image provider", () => {
  it("ignores login discovery that finishes after daemon shutdown", async () => {
    const cli = fakeServer();
    const { provider, connect, connection } = await setup();
    let release!: (value: typeof connection) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    provider.summarySnapshot(true);
    const catalog = provider.catalog();
    provider.close();
    release(connection);
    expect((await catalog).models).toEqual([]);
    provider.summarySnapshot(true);
    expect(connect).toHaveBeenCalledOnce();
    expect(cli.calls).toEqual([]);
  });

  it("returns snapshots immediately, skips disabled login checks and shares background discovery", async () => {
    const cli = fakeServer();
    const { provider, connect, connection } = await setup();
    let release!: (value: typeof connection) => void;
    connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(provider.summarySnapshot(false)).toMatchObject({
      enabled: false,
      configured: false,
      authStatus: "unknown",
    });
    expect(connect).not.toHaveBeenCalled();
    expect(provider.summarySnapshot(true)).toMatchObject({
      enabled: true,
      configured: false,
    });
    provider.summarySnapshot(true);
    expect(connect).toHaveBeenCalledOnce();
    const catalog = provider.catalog();
    release(connection);
    expect((await catalog).models).toEqual([CODEX_IMAGE_MODEL]);
    expect(provider.summarySnapshot(false)).toMatchObject({
      enabled: false,
      configured: true,
    });
    expect(provider.summarySnapshot(true)).toMatchObject({
      enabled: true,
      configured: true,
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(cli.calls).toEqual([]);
  });

  it("offers the image model from saved sign-in without starting an app-server", async () => {
    const cli = fakeServer();
    const { provider } = await setup();
    expect(await provider.summary(true)).toMatchObject({
      id: "codex-cli",
      configured: true,
      authStatus: "signed-in",
      capabilities: ["image"],
    });
    expect((await provider.catalog()).models).toEqual([CODEX_IMAGE_MODEL]);
    expect(cli.calls).toEqual([]);
  });

  it("passes multiple references in order without staging files, generates once and deduplicates completed events", async () => {
    const references = Array.from(
      { length: IMAGE_MAX_REFERENCE_IMAGES },
      (_, index) => ({
        data: Buffer.concat([png, Buffer.from(`reference-${index}`)]).toString(
          "base64",
        ),
        mediaType: "image/png" as const,
      }),
    );
    const cli = fakeServer({
      onTurn: async (message) => {
        expect(message.params.input).toEqual([
          { type: "text", text: "An orange cat", text_elements: [] },
          ...references.map((image) => ({
            type: "image",
            url: `data:${image.mediaType};base64,${image.data}`,
          })),
        ]);
        const thread = cli.calls.find(
          (call) => call.method === "thread/start",
        )!;
        expect(await readdir(thread.params.cwd)).toEqual([".owner.json"]);
      },
    });
    const { provider, root, connect } = await setup();
    expect(
      await provider.generate({
        prompt: "An orange cat",
        images: references,
      }),
    ).toEqual({ bytes: png, mediaType: "image/png" });
    expect(connect).toHaveBeenCalledWith(true);
    expect(
      cli.calls.some(
        (call) => call.method === "modelProvider/capabilities/read",
      ),
    ).toBe(false);
    const thread = cli.calls.find((call) => call.method === "thread/start")!;
    expect(thread.params).toMatchObject({
      ephemeral: true,
      dynamicTools: [],
      approvalPolicy: "never",
      permissions: "ohmygame-image",
      config: {
        "mcp_servers.external.enabled": false,
        "features.shell_tool": false,
        "features.multi_agent": false,
      },
    });
    expect(
      cli.calls.filter((call) => call.method === "turn/start"),
    ).toHaveLength(1);
    expect(await readdir(path.join(root, "sessions"))).toEqual([]);
    expect(cli.closed).toHaveBeenCalledOnce();
  });

  it("rechecks saved login without launching an image-capability probe", async () => {
    const cli = fakeServer();
    const { provider, connect } = await setup();
    await provider.summary(true);
    connect.mockClear();
    await provider.recheck(true);
    expect(connect).toHaveBeenCalledExactlyOnceWith(true);
    expect(cli.calls).toEqual([]);
  });

  it.each([
    { noImage: true, error: "no image" },
    { failed: true, error: "Account limit reached" },
  ])(
    "reports $error without substituting a text result or retrying",
    async ({ error, ...options }) => {
      const cli = fakeServer(options);
      const { provider } = await setup();
      await expect(provider.generate({ prompt: "A cat" })).rejects.toThrow(
        error,
      );
      expect(
        cli.calls.filter((call) => call.method === "turn/start"),
      ).toHaveLength(1);
    },
  );

  it("does not start inference when signed out", async () => {
    const cli = fakeServer();
    const { root, connection } = await setup();
    const signedOut = new CodexImageProvider(root, async () => ({
      ...connection,
      auth: { status: "signed-out", billing: "unknown" },
    }));
    expect(await signedOut.summary(true)).toMatchObject({
      configured: false,
      authStatus: "signed-out",
      error: expect.stringContaining("Sign in"),
    });
    expect((await signedOut.catalog()).models).toEqual([]);
    await expect(signedOut.generate({ prompt: "A cat" })).rejects.toThrow(
      "Sign in",
    );
    expect(cli.calls).toEqual([]);
  });

  it("offers a signed-in connection and reports CLI compatibility errors only when generating", async () => {
    const cli = fakeServer();
    const { root, connection } = await setup();
    const incompatible = new CodexImageProvider(root, async () => ({
      ...connection,
      error: "This Codex CLI cannot start an image thread",
    }));
    expect(await incompatible.summary(true)).toMatchObject({
      configured: true,
      authStatus: "signed-in",
      status: "connected",
    });
    expect((await incompatible.catalog()).models).toEqual([CODEX_IMAGE_MODEL]);
    await expect(incompatible.generate({ prompt: "A cat" })).rejects.toThrow(
      "This Codex CLI cannot start an image thread",
    );
    expect(cli.calls).toEqual([]);
  });

  it("cancels during thread startup and removes its private state", async () => {
    const cli = fakeServer({ hold: "thread/start" });
    const { provider, root } = await setup();
    const controller = new AbortController();
    const pending = provider.generate({ prompt: "A cat" }, controller.signal);
    void pending.catch(() => {});
    await vi.waitFor(() =>
      expect(cli.calls.some((call) => call.method === "thread/start")).toBe(
        true,
      ),
    );
    controller.abort(new Error("Cancelled by user"));
    await expect(pending).rejects.toThrow("Cancelled by user");
    expect(cli.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(await readdir(path.join(root, "sessions"))).toEqual([]);
  });

  it("routes canvas/default image selections without requiring Pi auth or an HTTP image source", async () => {
    const codexImages = {
      catalog: vi.fn(async () => ({
        models: [CODEX_IMAGE_MODEL],
        providers: [
          {
            provider: "codex-cli",
            providerName: "Codex CLI",
            state: "ready" as const,
          },
        ],
      })),
      generate: vi.fn(async () => ({
        bytes: png,
        mediaType: "image/png" as const,
      })),
    };
    const request = vi.fn<typeof fetch>();
    const images = new ProviderImages(
      async () => {
        throw new Error("Pi unavailable");
      },
      request,
      undefined,
      undefined,
      {
        codexImages,
        defaultModel: () => ({ provider: "codex-cli", id: "codex-image" }),
      },
    );
    expect((await images.catalog()).models).toContainEqual(CODEX_IMAGE_MODEL);
    const references = [
      { data: png.toString("base64"), mediaType: "image/png" as const },
      { data: png.toString("base64"), mediaType: "image/png" as const },
    ];
    await images.generate({
      prompt: "A cat",
      size: "1536x1024",
      resolution: "4K",
      aspectRatio: "16:9",
      images: references,
    });
    expect(codexImages.generate).toHaveBeenCalledWith(
      {
        prompt: "A cat",
        images: references,
      },
      undefined,
    );
    expect(request).not.toHaveBeenCalled();
    const disabled = new ProviderImages(
      async () => {
        throw new Error("Pi unavailable");
      },
      request,
      undefined,
      (id) => id !== "codex-cli",
      { codexImages },
    );
    expect((await disabled.catalog()).models).toEqual([]);
    await expect(
      disabled.generate({
        prompt: "A cat",
        imageModel: { provider: "codex-cli", id: "codex-image" },
      }),
    ).rejects.toThrow("disabled");
  });
});
