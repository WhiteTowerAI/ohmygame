import path from "node:path";
import type {
  ImageModel,
  ImageModelCatalog,
  ProviderSummary,
} from "../../shared/contracts.js";
import type { AgentRuntimeAuthStatus } from "../../shared/agent-runtimes.js";
import {
  ImageGenerationError,
  type GeneratedImage,
  type ImageGenerationInput,
} from "../openai-image.js";
import { sniffImageType } from "../image-format.js";
import {
  CodexAppServer,
  requireCodexPermissionProfile,
} from "./codex-app-server.js";
import { readCodexImage } from "./codex-images.js";
import { privateFolder } from "./discovery.js";
import { record } from "./driver-context.js";
import type { AgentRuntimeService } from "./service.js";

export const CODEX_IMAGE_MODEL: ImageModel = {
  provider: "codex-cli",
  providerName: "Codex CLI",
  id: "codex-image",
  name: "Codex Image",
  protocol: "codex-cli",
  sizes: [],
  generationOptions: [],
  supportsResolution: false,
  supportsAspectRatio: false,
  supportsReferenceImage: true,
  maxOutputs: 1,
};

type Connection = NonNullable<
  Awaited<ReturnType<AgentRuntimeService["codexImageConnection"]>>
>;
type Connect = (recheck?: boolean) => Promise<Connection | undefined>;
const REQUEST_TIMEOUT = 10_000;
const GENERATION_TIMEOUT = 5 * 60_000;
const STATUS_TTL = 60_000;

interface CodexImageStatus {
  authStatus: AgentRuntimeAuthStatus;
  message?: string;
}

/** Uses the installed CLI and its credential store, independently of conversation settings. */
export class CodexImageProvider {
  #statusSnapshot: CodexImageStatus = { authStatus: "unknown" };
  #statusCheckedAt = 0;
  #refresh?: Promise<CodexImageStatus>;
  #closed = false;

  constructor(
    private readonly root: string,
    private readonly connect: Connect,
  ) {}

  async recheck(enabled: boolean): Promise<ProviderSummary> {
    return this.summary(enabled, true);
  }

  /** Settings and onboarding must never wait for a local CLI to respond. */
  summarySnapshot(enabled: boolean): ProviderSummary {
    if (enabled && Date.now() - this.#statusCheckedAt >= STATUS_TTL)
      void this.#refreshStatus();
    return this.#summary(enabled, this.#statusSnapshot);
  }

  close(): void {
    // Ignore login discovery that finishes after daemon shutdown.
    this.#closed = true;
  }

  #refreshStatus(recheck = false): Promise<CodexImageStatus> {
    if (this.#closed) return Promise.resolve(this.#statusSnapshot);
    if (this.#refresh) {
      // An explicit recheck must observe login changes after an older check.
      return recheck
        ? this.#refresh.then(() => this.#refreshStatus(true))
        : this.#refresh;
    }
    const work = this.#status(recheck)
      .then((status) => {
        this.#statusSnapshot = status;
        this.#statusCheckedAt = Date.now();
        return status;
      })
      .finally(() => {
        if (this.#refresh === work) this.#refresh = undefined;
      });
    this.#refresh = work;
    return work;
  }

  async #status(recheck = false): Promise<CodexImageStatus> {
    try {
      const connection = await this.connect(recheck);
      if (this.#closed) return { authStatus: "unknown" };
      if (!connection)
        return {
          authStatus: "unknown",
          message:
            "Codex CLI was not found. Install it or choose its executable in Agents.",
        };
      const authStatus = connection.auth?.status ?? "unknown";
      return {
        authStatus,
        message:
          authStatus === "signed-in" ? undefined : connectionError(connection),
      };
    } catch (cause) {
      return { authStatus: "unknown", message: errorMessage(cause) };
    }
  }

  async summary(enabled: boolean, recheck = false): Promise<ProviderSummary> {
    return this.#summary(enabled, await this.#refreshStatus(recheck));
  }

  #summary(enabled: boolean, status: CodexImageStatus): ProviderSummary {
    const ready = status.authStatus === "signed-in";
    return {
      id: "codex-cli",
      name: "Codex CLI",
      source: "local-cli",
      methods: [],
      configured: ready,
      imageConfigured: ready,
      authStatus: status.authStatus,
      enabled,
      status: ready ? "connected" : "not_configured",
      capabilities: ["image"],
      ...(status.message ? { error: status.message } : {}),
    };
  }

  async catalog(signal?: AbortSignal): Promise<ImageModelCatalog> {
    signal?.throwIfAborted();
    const status = await this.#refreshStatus();
    signal?.throwIfAborted();
    const ready = status.authStatus === "signed-in";
    return {
      models: ready ? [CODEX_IMAGE_MODEL] : [],
      providers: [
        {
          provider: "codex-cli",
          providerName: "Codex CLI",
          state: ready ? "ready" : "empty",
          ...(status.message ? { message: status.message } : {}),
        },
      ],
    };
  }

  async generate(
    input: ImageGenerationInput,
    signal?: AbortSignal,
  ): Promise<GeneratedImage> {
    signal?.throwIfAborted();
    const prompt: Array<Record<string, unknown>> = [
      { type: "text", text: input.prompt, text_elements: [] },
      ...(input.images ?? []).map((image) => {
        if (
          image.data.length > Math.ceil((32 * 1024 * 1024) / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
        )
          throw new ImageGenerationError("Invalid Codex reference image", 400);
        const bytes = Buffer.from(image.data, "base64");
        const mediaType = sniffImageType(bytes);
        if (bytes.length > 32 * 1024 * 1024 || !mediaType)
          throw new ImageGenerationError("Invalid Codex reference image", 400);
        return { type: "image", url: `data:${mediaType};base64,${image.data}` };
      }),
    ];
    const connection = await this.connect(true);
    signal?.throwIfAborted();
    if (!connection)
      throw new ImageGenerationError("Codex CLI is not installed", 503);
    const authError = connectionError(connection);
    if (authError) throw new ImageGenerationError(authError, 503);
    const folder = await privateFolder(
      path.join(this.root, "sessions"),
      "codex-image",
    );
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(GENERATION_TIMEOUT)])
      : AbortSignal.timeout(GENERATION_TIMEOUT);
    let server: CodexAppServer | undefined;
    let threadId: string | undefined;
    let finished = false;
    const images = new Map<string, Promise<GeneratedImage>>();
    let resolve!: (image: GeneratedImage) => void;
    let reject!: (error: unknown) => void;
    const completed = new Promise<GeneratedImage>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Startup can fail before this promise is awaited.
    void completed.catch(() => {});
    const onAbort = () => {
      reject(abort.reason);
      // This process belongs only to this image job; stopping it also cancels startup.
      void server?.stop();
    };
    abort.addEventListener("abort", onAbort, { once: true });
    try {
      abort.throwIfAborted();
      server = new CodexAppServer(
        connection.path,
        folder.path,
        connection.env,
        {
          processDirectory: path.join(this.root, "processes"),
          exit: (failure) => reject(new ImageGenerationError(failure)),
          notification: (method, params) => {
            if (finished || params.threadId !== threadId || !threadId) return;
            const item = record(params.item);
            if (
              method === "item/completed" &&
              item?.type === "imageGeneration" &&
              typeof item.id === "string" &&
              !images.has(item.id)
            ) {
              const image =
                item.status === "completed" && !item.failure
                  ? readCodexImage(item, threadId, connection.env)
                  : Promise.reject(
                      new ImageGenerationError(
                        "Codex image generation failed. Check account access and usage limits.",
                      ),
                    );
              void image.catch(() => {});
              images.set(item.id, image);
            }
            if (method === "turn/completed") {
              finished = true;
              const turn = record(params.turn);
              if (turn?.status !== "completed") {
                reject(
                  new ImageGenerationError(
                    String(
                      record(turn?.error)?.message ??
                        "Codex could not finish image generation",
                    ),
                  ),
                );
                return;
              }
              void Promise.all(images.values()).then((results) => {
                if (abort.aborted) reject(abort.reason);
                else if (!results.length)
                  reject(
                    new ImageGenerationError(
                      "Codex returned no image. Built-in image generation may be unavailable for this account or model.",
                    ),
                  );
                else resolve(results[0]!);
              }, reject);
            }
          },
        },
      );
      await server.initialize(REQUEST_TIMEOUT);
      abort.throwIfAborted();
      const read = await server.request<{ config?: Record<string, unknown> }>(
        "config/read",
        { cwd: folder.path },
        REQUEST_TIMEOUT,
      );
      const profile = "ohmygame-image";
      // Windows' sandbox requires `:root` read access; `:minimal` is rejected.
      const filesystemPermissions: Record<string, unknown> =
        process.platform === "win32"
          ? { ":root": "read", ":workspace_roots": { ".": "read" } }
          : { ":minimal": "read", ":workspace_roots": { ".": "read" } };
      const config: Record<string, unknown> = {
        default_permissions: profile,
        permissions: {
          [profile]: {
            filesystem: filesystemPermissions,
            network: { enabled: true },
          },
        },
        "features.image_generation": true,
        "features.shell_tool": false,
        "features.unified_exec": false,
        "features.shell_snapshot": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.code_mode": false,
        "features.plugins": false,
        web_search: "disabled",
        notify: [],
        project_root_markers: [],
      };
      for (const name of Object.keys(record(read.config?.mcp_servers) ?? {}))
        config[`mcp_servers.${name}.enabled`] = false;
      const started = await server.request<{
        thread: { id: string };
        activePermissionProfile?: { id?: string };
      }>("thread/start", {
        cwd: folder.path,
        ephemeral: true,
        approvalPolicy: "never",
        permissions: profile,
        config,
        developerInstructions:
          "Generate exactly one image using your built-in image generation tool. Use the supplied reference images in their given order if present. Do not ask questions, run commands, edit files, use external tools or delegate. Do not substitute SVG, code, text or an API script for a generated image. If image generation is unavailable, report that failure.",
        dynamicTools: [],
      });
      requireCodexPermissionProfile(started, profile);
      threadId = started.thread?.id;
      if (!threadId)
        throw new ImageGenerationError("Codex did not start an image thread");
      abort.throwIfAborted();
      await server.request("turn/start", { threadId, input: prompt });
      const result = await completed;
      abort.throwIfAborted();
      return result;
    } catch (cause) {
      if (abort.aborted) throw abort.reason;
      if (cause instanceof ImageGenerationError) throw cause;
      throw new ImageGenerationError(errorMessage(cause), 503);
    } finally {
      finished = true;
      abort.removeEventListener("abort", onAbort);
      await server?.stop();
      // File-only results must be read before removing temporary state.
      await Promise.allSettled(images.values());
      await folder.remove();
    }
  }
}

function connectionError(connection: Connection): string | undefined {
  if (connection.error) return connection.error;
  if (connection.auth?.status !== "signed-in")
    return "Sign in to Codex CLI, then check again. OhMyGame uses the CLI's saved login.";
  return undefined;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
