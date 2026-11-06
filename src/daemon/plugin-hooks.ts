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
} from "../shared/plugin-hooks.js";
import type { NativePlugins } from "./native-plugins.js";
import type { PluginIndexEntry } from "./plugin-index.js";
import type { ProjectPlugins } from "./project-plugins.js";

// Runs plugins' hooks in a project: the native handlers its active plugins
// registered for the events their manifests list. Hooks that only hear run
// on their own; nothing waits for them and what they return changes nothing,
// beyond a notice for the person. `image.beforeGenerate` is the one hook
// whose answer is used, and only for an image's prompt and parameters.

/** How long a hook that only hears may take. */
const NOTIFY_TIMEOUT_MS = 30_000;
/** How long each plugin may take to change an image's request. */
const IMAGE_TIMEOUT_MS = 10_000;

type NotifyHook = Exclude<PluginHook, "image.beforeGenerate">;

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
  timeouts?: { notifyMs?: number; imageMs?: number };
}

export class PluginHooks {
  readonly #options: PluginHooksOptions;

  constructor(options: PluginHooksOptions) {
    this.#options = options;
  }

  /** The project's active plugins with native code that hear `event`, in the project's order. */
  async listeners(folder: string, event: PluginHook): Promise<PluginIndexEntry[]> {
    const resolved = await this.#options.resolve(folder).catch(() => undefined);
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
