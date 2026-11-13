import {
  IMAGE_ASPECT_RATIOS,
  IMAGE_RESOLUTIONS,
  IMAGE_SIZES,
  type RunImageToolRequest,
} from "../shared/contracts.js";
import {
  HOOK_NOTICE_MAX_CHARS,
  HOOK_PROMPT_MAX_CHARS,
  IMAGE_HOOK_CHANGE_FIELDS,
  manifestHooks,
  type ImageHookChange,
  type ImageHookInput,
  type ImageHookRecord,
  type PluginHook,
  type PluginHookInputs,
  type ToolHookInput,
} from "../shared/plugin-hooks.js";
import type { HostedToolHooks } from "./tool-hooks.js";
import type { NativePlugins } from "./native-plugins.js";
import type { PluginIndexEntry } from "./plugin-index.js";
import type { ProjectPlugins } from "./project-plugins.js";

// Runs plugins' hooks in a project: the native handlers its active plugins
// registered for the events their manifests list. Hooks that only hear run
// on their own; nothing waits for them and what they return changes nothing,
// beyond a notice for the person. Image hooks can change image parameters;
// tool gates can allow, deny or ask, without changing the tool arguments.

/** How long a hook that only hears may take. */
const NOTIFY_TIMEOUT_MS = 30_000;
/** How long each plugin may take to change an image's request. */
const IMAGE_TIMEOUT_MS = 10_000;

type NotifyHook = Exclude<PluginHook, "image.beforeGenerate" | "tool.beforeCall">;

export interface PluginNotice {
  plugin: string;
  message: string;
  tone: "default" | "danger";
}

export interface PluginHooksOptions {
  resolve: (folder: string) => Promise<ProjectPlugins>;
  native: Pick<NativePlugins, "hook">;
  /** A notice a hook returned, for the person to see. */
  onNotice?: (folder: string, notice: PluginNotice) => void;
  /** A hook that failed, timed out or answered with something unusable. */
  onError?: (plugin: string, event: PluginHook, error: unknown) => void;
  timeouts?: { notifyMs?: number; imageMs?: number; toolMs?: number };
}

export class PluginHooks {
  readonly #options: PluginHooksOptions;

  constructor(options: PluginHooksOptions) {
    this.#options = options;
  }

  /** A live gate: plugin changes apply to the next call, never grant a session. */
  tools(folder: string, approve?: (plugin: string, call: ToolHookInput, reason: string, signal?: AbortSignal) => Promise<boolean>): HostedToolHooks {
    return {
      before: async (call, signal) => {
        signal?.throwIfAborted();
        const listeners = await this.listeners(folder, "tool.beforeCall", true);
        for (const entry of listeners) {
          try {
            const value = await this.#options.native.hook(entry.id, "tool.beforeCall", {
              folder, input: structuredClone(call), version: entry.version, signal,
              timeoutMs: this.#options.timeouts?.toolMs ?? IMAGE_TIMEOUT_MS,
            });
            signal?.throwIfAborted();
            const answer = value as Record<string, unknown> | null;
            if (!answer || typeof answer !== "object" || Array.isArray(answer) ||
              Object.keys(answer).some((key) => key !== "decision" && key !== "reason") ||
              typeof answer.decision !== "string" || !["allow", "deny", "ask"].includes(answer.decision) ||
              (answer.reason !== undefined && (typeof answer.reason !== "string" || answer.reason.length > HOOK_NOTICE_MAX_CHARS)) ||
              (answer.decision !== "allow" && (typeof answer.reason !== "string" || !answer.reason.trim())))
              throw new Error("tool.beforeCall must return allow, deny or ask, with a reason for deny/ask; it cannot change arguments");
            if (answer.decision === "deny") throw new Error(String(answer.reason));
            if (answer.decision === "ask" && !await approve?.(entry.id, structuredClone(call), String(answer.reason), signal))
              throw new Error(approve ? "The person did not approve this call" : "Approval requires an active conversation in OhMyGame");
          } catch (cause) {
            this.#options.onError?.(entry.id, "tool.beforeCall", cause);
            throw new Error(`${entry.id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
          }
        }
        signal?.throwIfAborted();
        // Approval may have taken minutes. A changed gate must see a fresh call.
        const current = await this.listeners(folder, "tool.beforeCall", true);
        const identity = (entries: PluginIndexEntry[]) => entries.map((entry) => `${entry.id}:${entry.version}:${entry.digest}`).join("\n");
        if (identity(current) !== identity(listeners)) throw new Error("The project's tool hooks changed; retry the call");
        signal?.throwIfAborted();
      },
      after: (result) => this.notify(folder, "tool.afterCall", structuredClone(result)),
    };
  }

  /** The project's active plugins with native code that hear `event`, in the project's order. */
  async listeners(folder: string, event: PluginHook, strict = false): Promise<PluginIndexEntry[]> {
    const resolved = await this.#options.resolve(folder).catch((cause) => {
      if (strict) throw cause;
      return undefined;
    });
    if (strict && !resolved?.ok) throw new Error("Cannot resolve the project's tool hooks");
    if (!resolved?.ok) return [];
    return resolved.plugins.flatMap((plugin) =>
      plugin.status === "active" &&
      plugin.entry?.manifest.entrypoints?.native &&
      manifestHooks(plugin.entry.manifest).includes(event)
        ? [plugin.entry]
        : [],
    );
  }

  /** Whether a plugin on in the project wants to know when its files change: by a hook, or with a page that reads them. */
  async wantsFiles(folder: string): Promise<boolean> {
    const resolved = await this.#options.resolve(folder).catch(() => undefined);
    return Boolean(resolved?.ok && resolved.plugins.some((plugin) => {
      const manifest = plugin.status === "active" ? plugin.entry?.manifest : undefined;
      return Boolean(manifest && (
        (manifest.entrypoints?.native && manifestHooks(manifest).includes("files.changed")) ||
        (manifest.capabilities?.["project.files"] && manifest.contributes?.panels?.length)
      ));
    }));
  }

  /** Tells every plugin that hears `event`; resolves when they have all answered, and never fails. */
  async notify<E extends NotifyHook>(folder: string, event: E, input: PluginHookInputs[E]): Promise<void> {
    const listeners = await this.listeners(folder, event);
    await Promise.all(
      listeners.map(async (entry) => {
        try {
          const value = await this.#options.native.hook(entry.id, event, {
            folder,
            input,
            version: entry.version,
            timeoutMs: this.#options.timeouts?.notifyMs ?? NOTIFY_TIMEOUT_MS,
          });
          const notice = readNotice(value);
          if (notice) this.#options.onNotice?.(folder, { plugin: entry.id, ...notice });
        } catch (error) {
          this.#options.onError?.(entry.id, event, error);
        }
      }),
    );
  }

  /**
   * Lets each plugin that hears `image.beforeGenerate` change the request in
   * turn, and records who changed what. A plugin that fails, or answers
   * with a value it may not set, changes nothing.
   */
  async beforeImage(folder: string, request: RunImageToolRequest): Promise<RunImageToolRequest> {
    const listeners = await this.listeners(folder, "image.beforeGenerate");
    if (!listeners.length) return request;
    let current = request;
    const records: ImageHookRecord[] = [];
    for (const entry of listeners) {
      try {
        const value = await this.#options.native.hook(entry.id, "image.beforeGenerate", {
          folder,
          input: hookInput(current),
          version: entry.version,
          timeoutMs: this.#options.timeouts?.imageMs ?? IMAGE_TIMEOUT_MS,
        });
        const { request: next, fields } = applyImageChange(current, value);
        if (fields.length) {
          current = next;
          records.push({ plugin: entry.id, version: entry.version, fields });
        }
      } catch (error) {
        this.#options.onError?.(entry.id, "image.beforeGenerate", error);
      }
    }
    return records.length ? { ...current, requestedPrompt: request.prompt, pluginChanges: records } : current;
  }
}

/** What a hook that only hears said for the person, cut to length. */
function readNotice(value: unknown): Omit<PluginNotice, "plugin"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { notice, tone } = value as Record<string, unknown>;
  if (typeof notice !== "string" || !notice.trim()) return undefined;
  const text = notice.trim();
  return {
    message: text.length > HOOK_NOTICE_MAX_CHARS ? `${text.slice(0, HOOK_NOTICE_MAX_CHARS - 1)}…` : text,
    tone: tone === "danger" ? "danger" : "default",
  };
}

/** Whether the request names a pixel size rather than a resolution and aspect ratio. */
const sized = (request: RunImageToolRequest) =>
  request.resolution === undefined && request.aspectRatio === undefined;

function hookInput(request: RunImageToolRequest): ImageHookInput {
  return {
    prompt: request.prompt,
    ...(request.imageModel ? { imageModel: { provider: request.imageModel.provider, id: request.imageModel.id } } : {}),
    ...(request.size !== undefined ? { size: request.size } : {}),
    ...(request.resolution !== undefined ? { resolution: request.resolution } : {}),
    ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
    ...(request.transparentBackground !== undefined ? { transparentBackground: request.transparentBackground } : {}),
    references: "images" in request ? request.images?.length ?? 0 : 0,
  };
}

/** Why a plugin's value for `field` can't be used, or undefined when it can. */
function refusal(request: RunImageToolRequest, field: keyof ImageHookChange, value: unknown): string | undefined {
  switch (field) {
    case "prompt":
      return typeof value === "string" && value.trim() && value.length <= HOOK_PROMPT_MAX_CHARS
        ? undefined
        : `prompt must be text of at most ${HOOK_PROMPT_MAX_CHARS} characters`;
    case "imageModel": {
      const model = value as Record<string, unknown> | null;
      return model && typeof model === "object" && typeof model.provider === "string" && model.provider &&
        typeof model.id === "string" && model.id && model.provider.length <= 200 && model.id.length <= 200
        ? undefined
        : "imageModel must be { provider, id }";
    }
    case "size":
      if (!sized(request)) return "this request uses resolution and aspectRatio, not size";
      return (IMAGE_SIZES as readonly unknown[]).includes(value) ? undefined : `size must be one of ${IMAGE_SIZES.join(", ")}`;
    case "resolution":
      if (sized(request)) return "this request uses size, not resolution";
      return (IMAGE_RESOLUTIONS as readonly unknown[]).includes(value) ? undefined : `resolution must be one of ${IMAGE_RESOLUTIONS.join(", ")}`;
    case "aspectRatio":
      if (sized(request)) return "this request uses size, not aspectRatio";
      return (IMAGE_ASPECT_RATIOS as readonly unknown[]).includes(value) ? undefined : `aspectRatio must be one of ${IMAGE_ASPECT_RATIOS.join(", ")}`;
    case "transparentBackground":
      return typeof value === "boolean" ? undefined : "transparentBackground must be true or false";
  }
}

/**
 * The request with a plugin's changes, and which fields they changed. A
 * plugin that answers with nothing changes nothing; one that sets a field it
 * may not, or a value that can't be used, has its whole answer refused.
 */
export function applyImageChange(
  request: RunImageToolRequest,
  value: unknown,
): { request: RunImageToolRequest; fields: Array<keyof ImageHookChange> } {
  if (value === undefined || value === null) return { request, fields: [] };
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("image.beforeGenerate must return an object of changes, or nothing");
  const change = value as Record<string, unknown>;
  const unknown = Object.keys(change).filter((key) => !(IMAGE_HOOK_CHANGE_FIELDS as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`image.beforeGenerate can't change ${unknown.join(", ")}`);
  const next: Record<string, unknown> = { ...request };
  const fields: Array<keyof ImageHookChange> = [];
  for (const field of IMAGE_HOOK_CHANGE_FIELDS) {
    if (!(field in change) || change[field] === undefined) continue;
    const problem = refusal(request, field, change[field]);
    if (problem) throw new Error(`image.beforeGenerate: ${problem}`);
    const wanted = field === "imageModel"
      ? { provider: (change.imageModel as { provider: string }).provider, id: (change.imageModel as { id: string }).id }
      : change[field];
    if (JSON.stringify(wanted) === JSON.stringify(next[field])) continue;
    next[field] = wanted;
    fields.push(field);
  }
  return { request: next as unknown as RunImageToolRequest, fields };
}
