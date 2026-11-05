// Hooks: events a plugin's native code hears about in a project, declared in
// `contributes.hooks` and registered with `context.registerHook`. Every hook
// but `image.beforeGenerate` only hears: the app doesn't wait for it, and
// nothing it returns changes what happened.

export const PLUGIN_HOOKS = [
  "asset.added",
  "turn.completed",
  "build.started",
  "build.completed",
  "files.changed",
  "image.beforeGenerate",
] as const;

export type PluginHook = (typeof PLUGIN_HOOKS)[number];

export const isPluginHook = (value: unknown): value is PluginHook =>
  (PLUGIN_HOOKS as readonly unknown[]).includes(value);

/** The hooks a manifest lists; the schema's literal union reads as `never` in TypeScript. */
export const manifestHooks = (manifest: { contributes?: { hooks?: unknown } }): readonly PluginHook[] =>
  Array.isArray(manifest.contributes?.hooks) ? manifest.contributes.hooks.filter(isPluginHook) : [];

/** A file a turn changed, with forward slashes, relative to the project folder. */
export interface HookFileChange {
  path: string;
  kind: "added" | "modified" | "removed";
}

/** What each hook's handler receives. */
export interface PluginHookInputs {
  /** A generated asset was saved in the project, or one from the library was added to it. */
  "asset.added": {
    path: string;
    origin: "generated" | "imported";
    prompt?: string;
  };
  /** A turn ended, however it ended, with the files it changed. */
  "turn.completed": {
    conversationId: string;
    status: "completed" | "failed" | "cancelled";
    changes: HookFileChange[];
  };
  /** The project is about to be packed for export or publishing. */
  "build.started": { purpose: "export" | "publish" };
  "build.completed": {
    purpose: "export" | "publish";
    status: "succeeded" | "failed";
    /** The size of the package, when it was made. */
    bytes?: number;
    error?: string;
  };
  /** Files in the project changed, from OhMyGame or outside it. */
  "files.changed": { paths: string[]; truncated?: boolean };
  /** An image is about to be generated; the handler may return changes. */
  "image.beforeGenerate": ImageHookInput;
}

/** The prompt and the parameters a plugin may change before an image is generated. */
export interface ImageHookInput {
  prompt: string;
  /** The image model asked for, when the request names one. */
  imageModel?: { provider: string; id: string };
  /** Set when the request names a pixel size; then `resolution` and `aspectRatio` aren't. */
  size?: string;
  resolution?: string;
  aspectRatio?: string;
  transparentBackground?: boolean;
  /** How many reference images the request has; plugins can't change them. */
  references: number;
}

export type ImageHookChange = Partial<Omit<ImageHookInput, "references">>;

/** The fields `image.beforeGenerate` may change, in the order they are checked. */
export const IMAGE_HOOK_CHANGE_FIELDS = ["prompt", "imageModel", "size", "resolution", "aspectRatio", "transparentBackground"] as const satisfies ReadonlyArray<keyof ImageHookChange>;

/** What a hook that only hears may return: a line the app shows the person under the plugin's name. */
export interface HookNotice {
  notice?: string;
  tone?: "default" | "danger";
}

/** Longest notice the app shows; longer ones are cut. */
export const HOOK_NOTICE_MAX_CHARS = 300;
/** Most paths one `files.changed` carries. */
export const HOOK_FILES_MAX = 200;
/** Most changed files one `turn.completed` carries. */
export const HOOK_CHANGES_MAX = 500;
/** The longest prompt `image.beforeGenerate` may return. */
export const HOOK_PROMPT_MAX_CHARS = 8_000;

/** Who changed what in an image's request before it was generated. */
export interface ImageHookRecord {
  plugin: string;
  version: string;
  fields: Array<keyof ImageHookChange>;
}

/** Whether a stored list of image hook records is well formed. */
export function isImageHookRecords(value: unknown): value is ImageHookRecord[] {
  return Array.isArray(value) && value.every((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Partial<ImageHookRecord>;
    return typeof record.plugin === "string" && typeof record.version === "string" &&
      Array.isArray(record.fields) && record.fields.every((field) => (IMAGE_HOOK_CHANGE_FIELDS as readonly unknown[]).includes(field));
  });
}
