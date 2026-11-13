import { isBrowserUrl } from "./browser.js";
import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import { AUDIO_KINDS, AUDIO_OUTPUT_FORMATS } from "./audio.js";
import { CUSTOM_MODEL_APIS, IMAGE_ASPECT_RATIOS, IMAGE_RESOLUTIONS, VIDEO_ASPECT_RATIOS, VIDEO_REFERENCE_MODES, VIDEO_RESOLUTIONS } from "./contracts.js";
import { MAX_CAPTURE_FRAME, PLUGIN_GAME_USE_INPUT, PLUGIN_GAME_USE_OPERATIONS, type PluginGameUseInput, type PluginGameUseOperation, type PluginGameUseSpec } from "./playtest.js";
import { isNewerPluginVersion, isPluginVersion } from "./plugins.js";
import { PREVIEW_FILTER_COLOR_SPACES, PREVIEW_FILTER_MAX_COEFFICIENT } from "./preview-filter.js";
import { GAMEPAD_BUTTONS, GAMEPAD_STICKS, KEY_CODE_PATTERN, STICK_DIRECTIONS } from "./preview-input.js";
import { PLUGIN_UI_MAJORS, PLUGIN_UI_PREVIEW_MAJORS } from "./plugin-ui-versions.js";
import { compileWhen } from "./plugin-when.js";
import { PLUGIN_HOOKS, PLUGIN_INSTRUCTIONS_MAX_CHARS } from "./plugin-hooks.js";

// The plugin manifest at `.ohmygame-plugin/plugin.json`, read at
// install time without running any plugin code. The TypeBox schemas below
// are the source of the published JSON Schema (`schemas/plugin-2.json`), and
// `validatePluginManifest` adds the rules a schema can't express.

/** On the website, which serves `schemas/` from the repository's `main` branch, so releases update it. */
export const PLUGIN_MANIFEST_SCHEMA_URL =
  "https://www.ohmygame.ai/schema/plugin-2.json";
/** The plugin API this host implements; manifests name the range they need. */
export const PLUGIN_HOST_API_VERSION = "2.7.0";

/** `./path` inside the package, without `..` segments or backslashes. */
const RelativePath = (pattern = "") =>
  Type.String({
    pattern: `^\\./(?!\\.\\.(?:/|$))(?!.*/\\.\\.(?:/|$))[^\\\\]+${pattern}$`,
    minLength: 3,
    maxLength: 500,
  });
const Slug = Type.String({
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 64,
});
const CamelId = Type.String({
  pattern: "^[a-z][a-zA-Z0-9]*$",
  maxLength: 64,
});
const SnakeId = Type.String({
  pattern: "^[a-z][a-z0-9_]*$",
  maxLength: 64,
});
/** Shown in the UI: literal text, or a `%key%` from the plugin's locales. */
const Text = (maxLength = 200) => Type.String({ minLength: 1, maxLength });
const HttpsUrl = Type.String({ pattern: "^https://[^\\s]+$", maxLength: 500 });
const Icon = RelativePath("\\.(?:svg|png|webp)");
const VersionRange = Type.String({
  pattern: "^(?:\\^|~|>=)?(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$",
  description: "An exact version, or ^x.y.z, ~x.y.z or >=x.y.z",
});
const When = Type.String({ minLength: 1, maxLength: 300 });
/**
 * One segment of a project-relative path: no `.` or `..`, no drive letters,
 * backslashes, wildcards or control characters.
 */
const PROJECT_PATH_SEGMENT =
  "(?!\\.\\.?(?:/|$))[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]*";

/**
 * What a plugin helps with, in the order the Plugins page lists them. The app
 * leaves out a category it doesn't know, so a new one never stops an older
 * app from adding the plugin.
 */
export const PLUGIN_CATEGORIES = [
  // Starting a game, the agent and its models, making assets, shaping the game,
  // building and testing it, shipping it, and the rest.
  "engine",
  "templates",
  "agent",
  "provider",
  "art",
  "3d",
  "audio",
  "video",
  "design",
  "story",
  "workflow",
  "testing",
  "publishing",
  "online",
  "integration",
  "theme",
  "learning",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/** The largest media adapter script a provider may have. */
export const PLUGIN_MEDIA_ADAPTER_MAX_BYTES = 512 * 1024;

/** How many keywords a plugin may name, and how long each may be. */
export const PLUGIN_KEYWORDS_MAX = 8;
export const PLUGIN_KEYWORD_MAX_LENGTH = 30;

/** How many screenshots a plugin may show, and how large each file may be. */
export const PLUGIN_SCREENSHOTS_MAX = 6;
export const PLUGIN_SCREENSHOT_MAX_BYTES = 1024 * 1024;

export const PLUGIN_SLOTS = [
  "home.starters",
  "project.menu",
  "project.toolbar",
  "project.publish",
  "project.layout",
  "panel.toolbar",
  "composer.add",
  "composer.slash",
  "canvas.add",
  "canvas.node",
  "game.more",
] as const;

/** Colour tokens a theme may set; everything else derives from them. */
export const THEME_TOKENS = [
  ...Array.from({ length: 13 }, (_, index) => `--gray-${index}`),
  "--color-accent",
  "--color-on-accent",
  "--color-grid-dot",
  ...[
    "audio",
    "code",
    "data",
    "doc",
    "image",
    "model",
    "video",
    "danger",
    "success",
    "warning",
  ].map((hue) => `--hue-${hue}`),
  ...["comment", "keyword", "number", "string"].map(
    (token) => `--syntax-${token}`,
  ),
] as const;

const Literals = <const T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

const ConfigurationField = Type.Object(
  {
    type: Literals(["text", "secret", "path", "boolean", "select"]),
    title: Text(),
    description: Type.Optional(Text(500)),
    required: Type.Optional(Type.Boolean()),
    default: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

const Capabilities = Type.Object(
  {
    native: Type.Optional(Type.Boolean()),
    "project.selection": Type.Optional(Type.Boolean()),
    "project.files": Type.Optional(Literals(["read", "write"])),
    composer: Type.Optional(Type.Boolean()),
    /** Pages read the project's turns that changed files. */
    "project.history": Type.Optional(Type.Boolean()),
    /** Pages read what the project's conversations used. */
    "project.usage": Type.Optional(Type.Boolean()),
    agent: Type.Optional(Type.Boolean()),
    /**
     * Native code may play the project's game as the agent's game_use does
     * (API 2.3.0). Native code is trusted; this asks the person, it doesn't
     * contain a plugin that ignores it.
     */
    game: Type.Optional(Type.Boolean()),
    /** App-wide native session access and persistent activation (API 2.5.0). */
    sessions: Type.Optional(Type.Boolean()),
    network: Type.Optional(
      Type.Array(
        Type.String({ pattern: "^[a-z0-9.-]+(?::\\d+)?$", maxLength: 253 }),
        { minItems: 1, maxItems: 30, uniqueItems: true },
      ),
    ),
    secrets: Type.Optional(Type.Boolean()),
    processes: Type.Optional(
      Type.Array(
        Type.String({
          pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
          maxLength: 100,
        }),
        { minItems: 1, maxItems: 30, uniqueItems: true },
      ),
    ),
  },
  { additionalProperties: false },
);

const ProjectType = Type.Object(
  {
    id: Slug,
    title: Text(),
    description: Type.Optional(Text(500)),
    icon: Type.Optional(Icon),
    template: Type.Optional(RelativePath("/?")),
    recognize: Type.Optional(
      Type.Object(
        {
          files: Type.Array(
            Type.String({
              pattern: `^${PROJECT_PATH_SEGMENT}(?:/${PROJECT_PATH_SEGMENT})*$`,
              maxLength: 200,
              description: "A file path relative to the project root",
            }),
            { minItems: 1, maxItems: 10, uniqueItems: true },
          ),
        },
        { additionalProperties: false },
      ),
    ),
    preview: Literals(["web", "web-build", "native"]),
    playtest: Type.Optional(Literals(["web"])),
    gameUse: Type.Optional(
      Type.Object(
        {
          operations: Type.Array(Literals<PluginGameUseOperation>(PLUGIN_GAME_USE_OPERATIONS), {
            minItems: 1,
            uniqueItems: true,
          }),
          input: Type.Optional(
            Type.Array(Literals<PluginGameUseInput>(PLUGIN_GAME_USE_INPUT), {
              minItems: 1,
              uniqueItems: true,
            }),
          ),
          maxFrame: Type.Optional(
            Type.Integer({ minimum: 1, maximum: MAX_CAPTURE_FRAME }),
          ),
        },
        {
          additionalProperties: false,
          description:
            "A \"native\" type's game that game_use can open through the plugin's gameUse hook: the operations besides open and close it supports, the input act takes, and the highest frame captureFrame may ask for",
        },
      ),
    ),
    ready: Type.Optional(
      Type.Object(
        {
          command: Slug,
          panel: Slug,
        },
        {
          additionalProperties: false,
          description:
            "Before a prompt is sent in a project of this type, the app runs this native command (no input), which returns { ready, message? }; when not ready, the prompt waits and the panel opens. A message of the form %key% is looked up in the plugin's locale files",
        },
      ),
    ),
    panels: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);

/** How long a native call or an MCP request may run before it is cancelled; 60 seconds when unset. */
const TimeoutSeconds = Type.Integer({ minimum: 1, maximum: 3600 });

const Tool = Type.Object(
  {
    name: SnakeId,
    description: Type.String({ minLength: 1, maxLength: 1000 }),
    input: RelativePath("\\.json"),
    output: Type.Optional(RelativePath("\\.json")),
    timeoutSeconds: Type.Optional(TimeoutSeconds),
  },
  { additionalProperties: false },
);

const HexColor = Type.String({ pattern: "^#[0-9a-fA-F]{6}$" });

const CommandRun = Type.Union([
  Type.Object(
    {
      prompt: Type.String({ minLength: 1, maxLength: 4000 }),
      skill: Type.Optional(Slug),
      insert: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { tool: SnakeId, input: Type.Optional(Type.Unknown()) },
    { additionalProperties: false },
  ),
  Type.Object({ openPanel: Slug }, { additionalProperties: false }),
  Type.Object(
    { openSettings: Type.Literal(true) },
    { additionalProperties: false },
  ),
  Type.Object({ url: HttpsUrl }, { additionalProperties: false }),
  Type.Object(
    {
      native: CamelId,
      input: Type.Optional(RelativePath("\\.json")),
      timeoutSeconds: Type.Optional(TimeoutSeconds),
      changesFiles: Type.Optional(
        Type.Boolean({
          description:
            "false when the command never changes project files, such as a status check: it then runs during a turn and keeps no Undo",
        }),
      ),
      build: Type.Optional(
        Type.Literal("web", {
          description:
            "The app builds the game's web package first and gives the command its folder, as for Export web build",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

const Command = Type.Object(
  {
    id: Slug,
    title: Text(),
    icon: Type.Optional(Icon),
    slash: Type.Optional(Slug),
    run: CommandRun,
    slots: Type.Optional(
      Type.Array(
        Type.Object(
          { slot: Literals(PLUGIN_SLOTS), when: Type.Optional(When) },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 10 },
      ),
    ),
  },
  { additionalProperties: false },
);

/** What a canvas node's input accepts or its output makes. */
export const CANVAS_NODE_MEDIA = ["image", "text", "audio", "video", "model"] as const;
export const CANVAS_NODE_MAX_INPUTS = 8;
export const CANVAS_NODE_MAX_PARAMS = 16;
const CanvasNodeParam = Type.Object(
  {
    type: Literals(["text", "number", "boolean", "select"]),
    title: Text(),
    description: Type.Optional(Text(500)),
    default: Type.Optional(
      Type.Union([Type.String({ maxLength: 4000 }), Type.Number(), Type.Boolean()]),
    ),
    options: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
        minItems: 1,
        maxItems: 50,
        uniqueItems: true,
      }),
    ),
    minimum: Type.Optional(Type.Number()),
    maximum: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/**
 * A node a plugin adds to Asset Canvas: what it takes, the settings it
 * shows, and what its native code makes from them.
 */
const CanvasNode = Type.Object(
  {
    id: Slug,
    title: Text(),
    description: Type.Optional(Text(500)),
    inputs: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: CamelId,
            title: Text(),
            accepts: Literals(CANVAS_NODE_MEDIA),
            multiple: Type.Optional(Type.Boolean()),
            optional: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        { maxItems: CANVAS_NODE_MAX_INPUTS },
      ),
    ),
    params: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,63}$" }),
        CanvasNodeParam,
        { additionalProperties: false },
      ),
    ),
    output: Literals(CANVAS_NODE_MEDIA),
    run: Type.Object(
      { native: CamelId, timeoutSeconds: Type.Optional(TimeoutSeconds) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ASSET_SOURCE_MEDIA = ["image", "video", "audio", "model"] as const;

/**
 * A place the Library browses for media, such as a free asset site, shown as
 * a tab beside Local. Its `search` and `fetch` are native command handlers
 * (API 2.5.0).
 */
const AssetSource = Type.Object(
  {
    id: Slug,
    title: Text(60),
    description: Type.Optional(Text(500)),
    media: Type.Array(Literals(ASSET_SOURCE_MEDIA), { minItems: 1, uniqueItems: true }),
    search: CamelId,
    fetch: CamelId,
    timeoutSeconds: Type.Optional(TimeoutSeconds),
  },
  { additionalProperties: false },
);

/** A site on the Browser panel's new-tab page, under the plugin's name (API 2.5.0). */
const BrowserShortcut = Type.Object(
  {
    id: Slug,
    title: Text(60),
    url: HttpsUrl,
  },
  { additionalProperties: false },
);

/** A group of canvas nodes, in a JSON file of the package, to add to a board. */
const CanvasPreset = Type.Object(
  {
    id: Slug,
    title: Text(),
    description: Type.Optional(Text(500)),
    board: RelativePath("\\.json"),
  },
  { additionalProperties: false },
);

const SettingsRow = Type.Union([
  Type.Object({ field: CamelId }, { additionalProperties: false }),
  Type.Object(
    {
      title: Text(),
      description: Type.Optional(Text(500)),
      action: Type.Object({ command: Slug }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { widget: Literals(["status", "accounts", "quota"]) },
    { additionalProperties: false },
  ),
]);

const Settings = Type.Object(
  {
    section: Type.Optional(Literals(["agents", "providers"])),
    groups: Type.Array(
      Type.Object(
        {
          title: Type.Optional(Text()),
          rows: Type.Array(SettingsRow, { minItems: 1, maxItems: 30 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 10 },
    ),
  },
  { additionalProperties: false },
);

const ThemeValues = Type.Record(
  Type.String({ pattern: "^--[a-z0-9-]{1,40}$" }),
  Type.String({ minLength: 1, maxLength: 100 }),
  { additionalProperties: false },
);

const Theme = Type.Object(
  {
    id: Slug,
    title: Text(),
    dark: Type.Optional(ThemeValues),
    light: Type.Optional(ThemeValues),
  },
  { additionalProperties: false },
);

/**
 * How the app adds a provider's key to a request its media adapter marks
 * `auth: true`: in a header, with a scheme such as `Bearer`, or as a query
 * parameter. The adapter never sees the key.
 */
const MediaAuth = Type.Union([
  Type.Object(
    {
      header: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,63}$" }),
      scheme: Type.Optional(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9-]{0,31}$" })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { query: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }) },
    { additionalProperties: false },
  ),
]);

/**
 * What every media model has: its id and title, and for one the adapter lists
 * (`discoverModels`) a short description to find it by. `data` is the
 * adapter's own, at most 4 KB as JSON, given back as `input.modelData`, such
 * as which of the vendor's fields the model takes (API 2.5.0).
 */
const MEDIA_MODEL_COMMON = {
  id: Type.String({ minLength: 1, maxLength: 200 }),
  title: Type.Optional(Text()),
  description: Type.Optional(Text(500)),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
};
/** The most a model's `data` may hold, as JSON. */
export const PLUGIN_MEDIA_MODEL_DATA_MAX_CHARACTERS = 4096;

const MediaImageModel = Type.Object(
  {
    ...MEDIA_MODEL_COMMON,
    resolutions: Type.Array(Literals(IMAGE_RESOLUTIONS), { minItems: 1, uniqueItems: true }),
    aspectRatios: Type.Array(Literals(IMAGE_ASPECT_RATIOS), { minItems: 1, uniqueItems: true }),
    /** How many pictures a request may pass along, 0 for none. */
    maxReferenceImages: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
  },
  { additionalProperties: false },
);

const MediaVideoModel = Type.Object(
  {
    ...MEDIA_MODEL_COMMON,
    /** Lengths in seconds it can make. */
    durations: Type.Array(Type.Integer({ minimum: 1, maximum: 30 }), { minItems: 1, maxItems: 30, uniqueItems: true }),
    resolutions: Type.Array(Literals(VIDEO_RESOLUTIONS), { minItems: 1, uniqueItems: true }),
    aspectRatios: Type.Array(Literals(VIDEO_ASPECT_RATIOS), { minItems: 1, uniqueItems: true }),
    /** How many pictures a request may pass along, 0 for none. */
    maxReferenceImages: Type.Optional(Type.Integer({ minimum: 0, maximum: 16 })),
    /**
     * How it uses those pictures: `frame` as the first (and last) frame,
     * `reference` as a look to follow. The first is the default.
     */
    referenceModes: Type.Optional(Type.Array(Literals(VIDEO_REFERENCE_MODES), { minItems: 1, uniqueItems: true })),
  },
  { additionalProperties: false },
);

const MediaAudioModel = Type.Object(
  {
    ...MEDIA_MODEL_COMMON,
    /** What it makes: `speech`, `sound-effect`, `music`. */
    kinds: Type.Array(Literals(AUDIO_KINDS), { minItems: 1, uniqueItems: true }),
    /** Speaks the prompt word for word in a voice, rather than following a description. */
    readsText: Type.Optional(Type.Boolean()),
    /** The voices it speaks in, the first by default. */
    voices: Type.Optional(
      Type.Array(
        Type.Object(
          { id: Type.String({ minLength: 1, maxLength: 200 }), name: Text() },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 500 },
      ),
    ),
    /** The files it can make; `mp3` when left out. */
    formats: Type.Optional(Type.Array(Literals(AUDIO_OUTPUT_FORMATS), { minItems: 1, uniqueItems: true })),
    maxTextCharacters: Type.Optional(Type.Integer({ minimum: 1, maximum: 32_000 })),
    minDurationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    maxDurationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
    /** Makes music without vocals when asked. */
    instrumental: Type.Optional(Type.Boolean()),
    /** Makes audio that loops seamlessly when asked. */
    loop: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** What a plugin's 3D model can make from (API 2.5.0). */
export const PLUGIN_3D_OPERATIONS = ["text", "image"] as const;

const Media3DModel = Type.Object(
  {
    ...MEDIA_MODEL_COMMON,
    /** `text`: from a prompt; `image`: from pictures of the object. */
    operations: Type.Array(Literals(PLUGIN_3D_OPERATIONS), { minItems: 1, uniqueItems: true }),
    /** Views of one object an `image` request may pass, the first the front; 1 when left out. */
    maxReferenceImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    /** The triangle counts it takes; a model with one size sets min, max and default alike. */
    polycount: Type.Object(
      {
        min: Type.Integer({ minimum: 100, maximum: 2_000_000 }),
        max: Type.Integer({ minimum: 100, maximum: 2_000_000 }),
        default: Type.Integer({ minimum: 100, maximum: 2_000_000 }),
        /** The counts the canvas offers; the default alone when left out. */
        presets: Type.Optional(Type.Array(Type.Integer({ minimum: 100, maximum: 2_000_000 }), { maxItems: 10, uniqueItems: true })),
      },
      { additionalProperties: false },
    ),
    /** Paints the model when asked. */
    texture: Type.Optional(Type.Boolean()),
    /** Makes PBR materials when asked. */
    pbr: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/**
 * The adapter's `models` step lists more of the vendor's models, which the
 * person turns on in Settings; the ones here are on by default (API 2.5.0).
 */
const DiscoverModels = Type.Optional(Type.Boolean());

/** How long one request may take, the download included, in minutes. */
const MaxMinutes = Type.Integer({ minimum: 1, maximum: 120 });

/**
 * What a provider makes besides chat (API 2.5.0). `adapter` is a script in
 * the package that turns OhMyGame's requests into the vendor's API, run in a
 * sandbox whose only way out is `host.fetch` to `capabilities.network`.
 */
const ProviderMedia = Type.Object(
  {
    adapter: RelativePath("\\.js"),
    auth: Type.Optional(MediaAuth),
    image: Type.Optional(
      Type.Object(
        { discoverModels: DiscoverModels, models: Type.Array(MediaImageModel, { minItems: 1, maxItems: 100 }) },
        { additionalProperties: false },
      ),
    ),
    video: Type.Optional(
      Type.Object(
        {
          /**
           * How long one video may take, the download included, in minutes:
           * 15 when left out. A self-hosted model or a long queue needs more.
           */
          maxMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
          discoverModels: DiscoverModels,
          models: Type.Array(MediaVideoModel, { minItems: 1, maxItems: 100 }),
        },
        { additionalProperties: false },
      ),
    ),
    /** Speech, sound effects and music; 10 minutes a request when `maxMinutes` is left out. */
    audio: Type.Optional(
      Type.Object(
        { maxMinutes: Type.Optional(MaxMinutes), discoverModels: DiscoverModels, models: Type.Array(MediaAudioModel, { minItems: 1, maxItems: 100 }) },
        { additionalProperties: false },
      ),
    ),
    /** 3D models as GLB; 15 minutes a request when `maxMinutes` is left out. */
    "3d": Type.Optional(
      Type.Object(
        { maxMinutes: Type.Optional(MaxMinutes), discoverModels: DiscoverModels, models: Type.Array(Media3DModel, { minItems: 1, maxItems: 100 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/** What a provider's media section can make, by the names of its sections. */
export const PLUGIN_MEDIA_KINDS = ["image", "video", "audio", "3d"] as const;
export type PluginMediaKind = (typeof PLUGIN_MEDIA_KINDS)[number];
const MEDIA_MODEL_SCHEMAS = { image: MediaImageModel, video: MediaVideoModel, audio: MediaAudioModel, "3d": Media3DModel };
/** One model of a kind, as a manifest lists it and an adapter's `models` step returns it. */
export interface PluginMediaModels {
  image: Static<typeof MediaImageModel>;
  video: Static<typeof MediaVideoModel>;
  audio: Static<typeof MediaAudioModel>;
  "3d": Static<typeof Media3DModel>;
}
export type PluginMediaModel = PluginMediaModels[PluginMediaKind];

/** A kind's models as Settings shows them: the manifest's, those turned on, and those the adapter listed. */
export interface PluginMediaModelList {
  kind: PluginMediaKind;
  /** Whether the adapter can list more of the vendor's models. */
  discoverable: boolean;
  /** When they were last listed in this session. */
  listedAt?: string;
  /** Listed models left out because they didn't pass the checks. */
  skipped?: number;
  models: Array<{ id: string; name: string; description?: string; default: boolean; shown: boolean }>;
}

/** What's wrong with a model of a kind beyond its schema, as [field, message]. */
export function mediaModelIssues(kind: PluginMediaKind, model: PluginMediaModel): Array<[string, string]> {
  const issues: Array<[string, string]> = [];
  if (model.data !== undefined && JSON.stringify(model.data).length > PLUGIN_MEDIA_MODEL_DATA_MAX_CHARACTERS)
    issues.push(["data", `must be at most ${PLUGIN_MEDIA_MODEL_DATA_MAX_CHARACTERS / 1024} KB as JSON`]);
  if (kind === "audio") {
    const audio = model as PluginMediaModels["audio"];
    if (audio.voices && !audio.readsText) issues.push(["voices", "voices are for a model that reads text"]);
    if (audio.minDurationSeconds && audio.maxDurationSeconds && audio.minDurationSeconds > audio.maxDurationSeconds)
      issues.push(["minDurationSeconds", "must not be more than maxDurationSeconds"]);
  }
  if (kind === "3d") {
    const range = (model as PluginMediaModels["3d"]).polycount;
    if (!(range.min <= range.default && range.default <= range.max) || range.presets?.some((count) => count < range.min || count > range.max))
      issues.push(["polycount", "needs min ≤ default and presets ≤ max"]);
  }
  return issues;
}

/**
 * Checks a model an adapter's `models` step returned, as a manifest's models
 * are checked: what's wrong with it, or undefined when it can be listed.
 */
export function pluginMediaModelProblem(kind: PluginMediaKind, value: unknown): string | undefined {
  const [error] = Errors(MEDIA_MODEL_SCHEMAS[kind], value);
  if (error) return `${error.instancePath || "/"} ${error.message}`;
  const [issue] = mediaModelIssues(kind, value as PluginMediaModel);
  return issue ? `/${issue[0]} ${issue[1]}` : undefined;
}

const Provider = Type.Object(
  {
    id: Slug,
    title: Text(),
    icon: Type.Optional(Icon),
    /** Chat, with `baseUrl`; a provider that only makes media leaves both out. */
    api: Type.Optional(Literals(CUSTOM_MODEL_APIS)),
    baseUrl: Type.Optional(HttpsUrl),
    /** A `secret` configuration field holding the key. */
    apiKey: Type.Optional(CamelId),
    models: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1, maxLength: 200 }),
            title: Type.Optional(Text()),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 200 },
      ),
    ),
    discoverModels: Type.Optional(Type.Boolean()),
    media: Type.Optional(ProviderMedia),
  },
  { additionalProperties: false },
);

/**
 * A coding agent the plugin adds, which speaks the Agent Client Protocol on
 * its stdio. `command` is a program on the person's computer, found as the
 * built-in agents are; it runs only once the person turns the agent on in
 * Settings → Agents, as a built-in agent does.
 */
const Agent = Type.Object(
  {
    id: Slug,
    title: Text(),
    /** Its logo, shown in Settings → Agents and the model menu (API 2.5.0). */
    icon: Type.Optional(Icon),
    command: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", maxLength: 100 }),
    /** What starts the protocol, such as `["--acp"]`. */
    args: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 20 }),
    ),
    installUrl: Type.Optional(HttpsUrl),
    /** What to run in a terminal to sign in. */
    loginCommand: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  },
  { additionalProperties: false },
);

/** A string that may name configuration values as `${config.field}`. */
const Template = (maxLength = 2000) => Type.String({ maxLength });

/**
 * An MCP server the plugin brings: a process (`command`, run from the
 * plugin's folder unless `cwd` says otherwise), or an HTTP server (`url`,
 * whose host `capabilities.network` must list). Agents see only the `tools`
 * it names.
 */
const McpProcessServer = Type.Object(
  {
    id: Slug,
    title: Text(),
    command: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$", maxLength: 100 }),
    args: Type.Optional(Type.Array(Template(), { maxItems: 50 })),
    env: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }), Template(), {
        additionalProperties: false,
      }),
    ),
    cwd: Type.Optional(RelativePath("/?")),
    tools: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,100}$" }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
    timeoutSeconds: Type.Optional(TimeoutSeconds),
  },
  { additionalProperties: false },
);

const McpHttpServer = Type.Object(
  {
    id: Slug,
    title: Text(),
    url: Template(),
    headers: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z0-9-]{1,64}$" }), Template(), {
        additionalProperties: false,
      }),
    ),
    tools: Type.Array(Type.String({ pattern: "^[A-Za-z0-9_.-]{1,100}$" }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
    timeoutSeconds: Type.Optional(TimeoutSeconds),
  },
  { additionalProperties: false },
);

const McpServer = Type.Union([McpProcessServer, McpHttpServer]);

const Panel = Type.Object(
  {
    id: Slug,
    title: Text(),
    icon: Type.Optional(Icon),
    area: Literals(["left", "center", "right", "bottom"]),
    entry: RelativePath("\\.html"),
    when: Type.Optional(When),
  },
  { additionalProperties: false },
);

/**
 * A size the preview can show the game at, beside the built-in ones. It sets
 * the game's viewport only; it doesn't emulate the device. Its size limits
 * are game_use's.
 */
const PreviewDevice = Type.Object(
  {
    id: Slug,
    title: Text(),
    width: Type.Integer({ minimum: 240, maximum: 4096 }),
    height: Type.Integer({ minimum: 240, maximum: 4096 }),
  },
  { additionalProperties: false },
);

const FilterRow = (limit: number) =>
  Type.Array(Type.Number({ minimum: -limit, maximum: limit }), { minItems: 3, maxItems: 3 });

/**
 * A colour matrix over the game as the person sees it. It changes red, green
 * and blue only, keeps alpha, and names the colour space its coefficients are
 * for and where they come from.
 */
const PreviewFilter = Type.Object(
  {
    id: Slug,
    title: Text(),
    /** Where the coefficients come from, such as a paper, deficiency and severity. */
    source: Text(300),
    colorSpace: Literals(PREVIEW_FILTER_COLOR_SPACES),
    matrix: Type.Array(FilterRow(PREVIEW_FILTER_MAX_COEFFICIENT), { minItems: 3, maxItems: 3 }),
    offset: Type.Optional(FilterRow(1)),
  },
  { additionalProperties: false },
);

const KeyCode = Type.String({ pattern: KEY_CODE_PATTERN });
const keyRecord = (names: readonly string[]) =>
  Type.Object(Object.fromEntries(names.map((name) => [name, Type.Optional(KeyCode)])), { additionalProperties: false });

/**
 * A standard gamepad's buttons and sticks pressed as keys (`KeyboardEvent.code`),
 * for a game that only reads the keyboard. Off until the person picks it.
 */
const InputMap = Type.Object(
  {
    id: Slug,
    title: Text(),
    buttons: Type.Optional(keyRecord(GAMEPAD_BUTTONS)),
    sticks: Type.Optional(
      Type.Object(
        Object.fromEntries(GAMEPAD_STICKS.map((stick) => [stick, Type.Optional(keyRecord(STICK_DIRECTIONS))])),
        { additionalProperties: false },
      ),
    ),
    /** How far a stick goes before it presses its key, from 0.1 to 0.9; 0.5 by default. */
    deadZone: Type.Optional(Type.Number({ minimum: 0.1, maximum: 0.9 })),
  },
  { additionalProperties: false },
);

const list = <T extends Parameters<typeof Type.Array>[0]>(item: T) =>
  Type.Optional(Type.Array(item, { minItems: 1, maxItems: 50 }));

const PLUGIN_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$";

/** The publisher of plugins the person makes themselves. */
export const PERSONAL_PUBLISHER = "personal";
/**
 * The publisher of OhMyGame's own plugins: those it bundles, and those in its
 * `@ohmygame` npm scope, which only its organization can publish to.
 */
export const OHMYGAME_PUBLISHER = "ohmygame";
/**
 * Publishers only OhMyGame and its Plugin Builder use, so no package from
 * outside can, apart from OhMyGame's own from npm (`assertAddablePlugin`).
 */
export const RESERVED_PUBLISHERS: ReadonlySet<string> = new Set([OHMYGAME_PUBLISHER, PERSONAL_PUBLISHER]);

/** Whether `id` is a plugin id, `publisher/name`, safe to use as a path. */
export function isPluginId(id: string): boolean {
  return id.length <= 129 && new RegExp(PLUGIN_ID_PATTERN).test(id);
}

export const PluginManifestV2Schema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    id: Type.String({
      pattern: PLUGIN_ID_PATTERN,
      maxLength: 129,
      description: "publisher/name",
    }),
    version: Type.String({ minLength: 5, maxLength: 256 }),
    engines: Type.Object(
      { "ohmygame-api": VersionRange },
      { additionalProperties: false },
    ),
    displayName: Text(80),
    description: Text(300),
    /** The plugin's page shows it under About. */
    longDescription: Type.Optional(Text(2000)),
    /** Prompts the plugin's page offers to try it with. */
    examples: Type.Optional(
      Type.Array(Text(300), { minItems: 1, maxItems: 5 }),
    ),
    /** Still being checked on real projects; the app marks it Beta. */
    beta: Type.Optional(Type.Boolean()),
    icon: Type.Optional(Icon),
    /** Project types the plugin suits: built-in ids, or `publisher/name:type`. */
    appliesTo: Type.Optional(
      Type.Array(
        Type.String({
          pattern:
            "^(?:[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*:)?[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 200,
        }),
        { minItems: 1, maxItems: 20, uniqueItems: true },
      ),
    ),
    /** Pictures of it at work, shown on its page in the app and the market (API 2.4.0). */
    screenshots: Type.Optional(
      Type.Array(
        Type.Object(
          { path: RelativePath("\\.(?:png|jpe?g|webp)"), caption: Type.Optional(Text(120)) },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: PLUGIN_SCREENSHOTS_MAX, uniqueItems: true },
      ),
    ),
    categories: Type.Optional(
      Type.Array(Literals(PLUGIN_CATEGORIES), {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
    ),
    /** Words people may search for it by, shown on its page (API 2.5.0). */
    keywords: Type.Optional(
      Type.Array(Text(PLUGIN_KEYWORD_MAX_LENGTH), { minItems: 1, maxItems: PLUGIN_KEYWORDS_MAX, uniqueItems: true }),
    ),
    links: Type.Optional(
      Type.Object(
        {
          homepage: Type.Optional(HttpsUrl),
          sponsor: Type.Optional(HttpsUrl),
        },
        { additionalProperties: false },
      ),
    ),
    entrypoints: Type.Optional(
      Type.Object(
        { native: Type.Optional(RelativePath("\\.m?js")) },
        { additionalProperties: false },
      ),
    ),
    capabilities: Type.Optional(Capabilities),
    /**
     * Files or folders, such as `./.maker/`, the plugin leaves in a project.
     * Uninstalling lists them and leaves them, since they're the project's.
     */
    projectFiles: Type.Optional(
      Type.Array(RelativePath(), { minItems: 1, maxItems: 20, uniqueItems: true }),
    ),
    /**
     * The plugin's pages: `major` is the version of the page components they
     * use, `preview` lets them load one still in preview, and `accent` is its
     * brand colour, used for progress, selection and links where it stands out
     * from the panel's surface.
     */
    ui: Type.Optional(
      Type.Object(
        {
          major: Type.Optional(Type.Integer({ minimum: 1, maximum: 999 })),
          preview: Type.Optional(Type.Boolean()),
          accent: Type.Optional(
            Type.Union([
              HexColor,
              Type.Object(
                { light: Type.Optional(HexColor), dark: Type.Optional(HexColor) },
                { additionalProperties: false },
              ),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    configuration: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[a-z][a-zA-Z0-9]{0,63}$" }),
        ConfigurationField,
        { additionalProperties: false },
      ),
    ),
    contributes: Type.Optional(
      Type.Object(
        {
          projectTypes: list(ProjectType),
          skills: Type.Optional(RelativePath("/?")),
          instructions: Type.Optional(Type.String({ minLength: 1, maxLength: PLUGIN_INSTRUCTIONS_MAX_CHARS, pattern: "\\S" })),
          tools: list(Tool),
          commands: list(Command),
          settings: Type.Optional(Settings),
          themes: list(Theme),
          providers: list(Provider),
          agents: list(Agent),
          panels: list(Panel),
          mcpServers: list(McpServer),
          previewDevices: list(PreviewDevice),
          previewFilters: list(PreviewFilter),
          inputMaps: list(InputMap),
          /** Events the native entry hears about; see `PluginHookInputs`. */
          hooks: Type.Optional(
            Type.Array(Literals(PLUGIN_HOOKS), { minItems: 1, uniqueItems: true }),
          ),
          canvasNodes: list(CanvasNode),
          canvasPresets: list(CanvasPreset),
          assetSources: list(AssetSource),
          browserShortcuts: list(BrowserShortcut),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type PluginManifestV2 = Static<typeof PluginManifestV2Schema>;
export type PluginContributions = NonNullable<PluginManifestV2["contributes"]>;

/**
 * Whether a plugin only adds Skills and asks for nothing. Such a plugin can't
 * run code or reach files of its own, so it can apply to every project it
 * suits without a project turning it on.
 */
export function isAppWidePlugin(manifest: PluginManifestV2): boolean {
  const contributes = manifest.contributes ?? {};
  return (
    !manifest.entrypoints?.native &&
    !manifest.configuration &&
    Object.values(manifest.capabilities ?? {}).every(
      (value) => value === undefined || value === false || (Array.isArray(value) && !value.length),
    ) &&
    contributes.skills !== undefined &&
    Object.entries(contributes).every(
      ([key, value]) => key === "skills" || value === undefined,
    )
  );
}

/** What makes a plugin and this version of the app work together. */
export type PluginVersionFix = "update-app" | "update-plugin";

export interface PluginManifestIssue {
  /** When the plugin is fine but made for another version of the app. */
  fix?: PluginVersionFix;
  /** JSON Pointer into the manifest, such as `/contributes/themes/0/dark`. */
  path: string;
  message: string;
}

/**
 * `ignored` lists what the manifest says that this app doesn't know: fields
 * and category or hook names from a newer plugin API, or typos. The app reads
 * the manifest without them; `plugin check` shows them as warnings.
 */
export type PluginManifestResult =
  | { ok: true; manifest: PluginManifestV2; ignored?: PluginManifestIssue[] }
  | { ok: false; issues: PluginManifestIssue[]; ignored?: PluginManifestIssue[] };

/** The plain JSON Schema TypeBox builds, as far as reading a manifest needs it. */
interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  const?: unknown;
}

/** Lists whose values a newer app may add to; this one leaves out the names it doesn't know. */
const OPEN_LISTS = new Set(["/categories", "/contributes/hooks"]);
const IGNORED = "isn't known to this version of OhMyGame, so it's ignored";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The manifest without what this app doesn't know, so a plugin made for a
 * newer API still loads; whether it needs that API is up to its
 * `engines["ohmygame-api"]`. Only fields are left out, never a malformed value:
 * what remains is checked against the full schema. A value that could be more
 * than one form keeps its unknown fields, so it still fails as it did.
 */
function withoutUnknown(schema: SchemaNode, value: unknown, at: string, ignored: PluginManifestIssue[]): unknown {
  if (schema.anyOf) {
    if (!isRecord(value)) return value;
    const forms = schema.anyOf.filter((form) => form.type === "object" && (form.required ?? []).every((key) => Object.hasOwn(value, key)));
    return forms.length === 1 ? withoutUnknown(forms[0]!, value, at, ignored) : value;
  }
  if (schema.type === "array" && schema.items && Array.isArray(value)) {
    const names = OPEN_LISTS.has(at) ? schema.items.anyOf?.map((form) => form.const) : undefined;
    if (names) {
      const known = value.filter((item, index) => {
        if (typeof item !== "string" || names.includes(item)) return true;
        ignored.push({ path: `${at}/${index}`, message: `"${item}" ${IGNORED}` });
        return false;
      });
      return known;
    }
    return value.map((item, index) => withoutUnknown(schema.items!, item, `${at}/${index}`, ignored));
  }
  if (schema.type !== "object" || !isRecord(value)) return value;
  const entries: [string, unknown][] = [];
  for (const [key, item] of Object.entries(value)) {
    const path = `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    const property = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key]! : undefined;
    const pattern = property ? undefined : Object.entries(schema.patternProperties ?? {}).find(([source]) => new RegExp(source, "u").test(key))?.[1];
    if (property || pattern) {
      const known = withoutUnknown((property ?? pattern)!, item, path, ignored);
      // An open list whose every name is unknown says nothing this app can use.
      if (!(OPEN_LISTS.has(path) && Array.isArray(item) && item.length && Array.isArray(known) && !known.length)) entries.push([key, known]);
    } else if (schema.additionalProperties === false && !schema.patternProperties) {
      ignored.push({ path, message: IGNORED });
    } else entries.push([key, item]);
  }
  // fromEntries defines each key, so one named __proto__ stays an ordinary field.
  return Object.fromEntries(entries);
}

/** A CSS colour a theme value may be: hex, or an rgb/hsl/oklch function. */
const COLOR =
  /^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]+\))$/;

/** Checks a manifest against the schema and the rules it can't express. */
export function validatePluginManifest(value: unknown): PluginManifestResult {
  const ignored: PluginManifestIssue[] = [];
  const known = withoutUnknown(PluginManifestV2Schema as SchemaNode, value, "", ignored);
  const notes = () => (ignored.length ? { ignored } : {});
  const schemaIssues = [...Errors(PluginManifestV2Schema, known)]
    .filter((error) => error.keyword !== "boolean")
    .map((error) => ({
      path: error.instancePath,
      message: error.message,
    }));
  if (schemaIssues.length) return { ok: false, issues: schemaIssues, ...notes() };
  const manifest = known as PluginManifestV2;
  const issues: PluginManifestIssue[] = [];
  const issue = (path: string, message: string) =>
    issues.push({ path, message });
  const contributes = manifest.contributes ?? {};
  const capabilities = manifest.capabilities ?? {};
  const native = Boolean(manifest.entrypoints?.native);

  if (!isPluginVersion(manifest.version))
    issue("/version", "must be a semantic version");
  if (native !== Boolean(capabilities.native))
    issue(
      "/capabilities/native",
      native
        ? "a native entrypoint needs the native capability"
        : "the native capability needs a native entrypoint",
    );
  if (capabilities.sessions && !native)
    issue("/capabilities/sessions", "only native code accesses app sessions");
  if (capabilities.game && !native)
    issue("/capabilities/game", "only native code plays the game");

  for (const [id, field] of Object.entries(manifest.configuration ?? {})) {
    const path = `/configuration/${id}`;
    if (field.type === "secret" && field.default !== undefined)
      issue(`${path}/default`, "a secret can't have a default");
    if (field.type === "select") {
      if (!field.options) issue(`${path}/options`, "a select needs options");
      else if (
        field.default !== undefined &&
        !field.options.includes(String(field.default))
      )
        issue(`${path}/default`, "must be one of the options");
    } else if (field.options)
      issue(`${path}/options`, "only a select has options");
    if (
      field.default !== undefined &&
      typeof field.default !== (field.type === "boolean" ? "boolean" : "string")
    )
      issue(
        `${path}/default`,
        `must be a ${field.type === "boolean" ? "boolean" : "string"}`,
      );
  }

  for (const key of [
    "projectTypes",
    "commands",
    "themes",
    "providers",
    "agents",
    "panels",
    "mcpServers",
    "previewDevices",
    "previewFilters",
    "inputMaps",
    "canvasNodes",
    "canvasPresets",
    "assetSources",
    "browserShortcuts",
  ] as const) {
    const seen = new Set<string>();
    contributes[key]?.forEach((item, index) => {
      if (seen.has(item.id))
        issue(`/contributes/${key}/${index}/id`, `duplicate id ${item.id}`);
      seen.add(item.id);
    });
  }
  contributes.browserShortcuts?.forEach((shortcut, index) => {
    if (!isBrowserUrl(shortcut.url)) issue(`/contributes/browserShortcuts/${index}/url`, "must be a web address without credentials");
  });
  const toolNames = new Set<string>();
  contributes.tools?.forEach((tool, index) => {
    if (toolNames.has(tool.name))
      issue(`/contributes/tools/${index}/name`, `duplicate tool ${tool.name}`);
    toolNames.add(tool.name);
  });
  if (contributes.tools && !native)
    issue("/contributes/tools", "tools run in the native entrypoint");
  if (contributes.hooks && !native)
    issue("/contributes/hooks", "hooks run in the native entrypoint");
  contributes.tools?.forEach((tool, index) => {
    if (agentToolName(manifest.id, tool.name).length > AGENT_TOOL_NAME_MAX)
      issue(
        `/contributes/tools/${index}/name`,
        `with the plugin id it must fit in ${AGENT_TOOL_NAME_MAX} characters`,
      );
  });

  const slashes = new Set<string>();
  const panels = new Set(contributes.panels?.map((panel) => panel.id));
  const commands = new Set(contributes.commands?.map((command) => command.id));
  contributes.projectTypes?.forEach((type, index) => {
    // Literal unions read as never in the inferred types, so the declaration is read as written.
    const gameUse = type.gameUse as PluginGameUseSpec | undefined;
    if (!gameUse) return;
    const path = `/contributes/projectTypes/${index}/gameUse`;
    if ((type.preview as string) !== "native")
      issue(path, "only a \"native\" type runs its game through its plugin");
    if (!native) issue(path, "needs a native entrypoint");
    const acts = gameUse.operations.includes("act");
    if (acts && !gameUse.input) issue(`${path}/input`, "act needs the input it takes");
    if (!acts && gameUse.input) issue(`${path}/input`, "only act takes input");
    const frames = gameUse.operations.includes("captureFrame");
    if (frames && gameUse.maxFrame === undefined)
      issue(`${path}/maxFrame`, "captureFrame needs the highest frame it can capture");
    if (!frames && gameUse.maxFrame !== undefined)
      issue(`${path}/maxFrame`, "only captureFrame takes a frame");
  });
  contributes.projectTypes?.forEach((type, index) => {
    if (!type.ready) return;
    const path = `/contributes/projectTypes/${index}/ready`;
    const run = contributes.commands?.find((command) => command.id === type.ready!.command)?.run;
    if (!run || !("native" in run) || run.input)
      issue(`${path}/command`, `must name a native command without input`);
    if (!panels.has(type.ready.panel))
      issue(`${path}/panel`, `no panel named ${type.ready.panel}`);
  });
  contributes.commands?.forEach((command, index) => {
    const path = `/contributes/commands/${index}`;
    const run = command.run;
    if ("tool" in run && !toolNames.has(run.tool))
      issue(`${path}/run/tool`, `no tool named ${run.tool}`);
    if ("native" in run && !native)
      issue(`${path}/run/native`, "needs a native entrypoint");
    if ("openPanel" in run && !panels.has(run.openPanel))
      issue(`${path}/run/openPanel`, `no panel named ${run.openPanel}`);
    command.slots?.forEach((slot, slotIndex) => {
      const compiled = slot.when === undefined ? undefined : compileWhen(slot.when);
      if (compiled && !compiled.ok)
        issue(`${path}/slots/${slotIndex}/when`, compiled.error);
      if (slot.slot === "panel.toolbar") {
        if (!panels.size)
          issue(`${path}/slots/${slotIndex}/slot`, "panel.toolbar needs a panel");
        if ("native" in run && run.input)
          issue(`${path}/slots/${slotIndex}/slot`, "a toolbar button has no input to give this command");
      }
    });
    if (command.slash) {
      if (slashes.has(command.slash))
        issue(`${path}/slash`, `duplicate slash command ${command.slash}`);
      slashes.add(command.slash);
    }
  });

  contributes.inputMaps?.forEach((map, index) => {
    const keys = [...Object.values(map.buttons ?? {}), ...Object.values(map.sticks ?? {}).flatMap((stick) => Object.values(stick ?? {}))];
    if (!keys.length) issue(`/contributes/inputMaps/${index}`, "presses no keys");
  });

  contributes.assetSources?.forEach((_, index) => {
    if (!native) issue(`/contributes/assetSources/${index}/search`, "needs a native entrypoint");
  });
  contributes.canvasNodes?.forEach((node, index) => {
    const path = `/contributes/canvasNodes/${index}`;
    if (!native) issue(`${path}/run/native`, "needs a native entrypoint");
    const inputs = new Set<string>();
    node.inputs?.forEach((input, inputIndex) => {
      if (inputs.has(input.id))
        issue(`${path}/inputs/${inputIndex}/id`, `duplicate input ${input.id}`);
      // A board keeps inputs and settings in plain objects, where these names are already taken.
      if (input.id in Object.prototype) issue(`${path}/inputs/${inputIndex}/id`, `${input.id} is a reserved name`);
      inputs.add(input.id);
    });
    const params = Object.entries(node.params ?? {});
    if (params.length > CANVAS_NODE_MAX_PARAMS)
      issue(`${path}/params`, `at most ${CANVAS_NODE_MAX_PARAMS} settings`);
    for (const [key, param] of params) {
      if (key in Object.prototype) issue(`${path}/params/${key}`, `${key} is a reserved name`);
      const at = `${path}/params/${key}`;
      if (param.type === "select") {
        if (!param.options) issue(`${at}/options`, "a select needs options");
        else if (param.default !== undefined && !param.options.includes(String(param.default)))
          issue(`${at}/default`, "must be one of the options");
      } else if (param.options) issue(`${at}/options`, "only a select has options");
      if ((param.minimum !== undefined || param.maximum !== undefined) && param.type !== "number")
        issue(at, "only a number has a minimum or maximum");
      if (param.minimum !== undefined && param.maximum !== undefined && param.minimum > param.maximum)
        issue(`${at}/minimum`, "must not be more than the maximum");
      const expected = param.type === "boolean" ? "boolean" : param.type === "number" ? "number" : "string";
      if (param.default !== undefined && typeof param.default !== expected)
        issue(`${at}/default`, `must be a ${expected}`);
      else if (typeof param.default === "number" && ((param.minimum !== undefined && param.default < param.minimum) || (param.maximum !== undefined && param.default > param.maximum)))
        issue(`${at}/default`, "must be within the minimum and maximum");
    }
  });

  contributes.panels?.forEach((panel, index) => {
    const compiled = panel.when === undefined ? undefined : compileWhen(panel.when);
    if (compiled && !compiled.ok)
      issue(`/contributes/panels/${index}/when`, compiled.error);
  });

  contributes.settings?.groups.forEach((group, groupIndex) =>
    group.rows.forEach((row, rowIndex) => {
      const path = `/contributes/settings/groups/${groupIndex}/rows/${rowIndex}`;
      if ("field" in row && !manifest.configuration?.[row.field])
        issue(`${path}/field`, `no configuration field ${row.field}`);
      if ("action" in row && !commands.has(row.action.command))
        issue(`${path}/action/command`, `no command ${row.action.command}`);
    }),
  );

  const tokens = new Set<string>(THEME_TOKENS);
  contributes.themes?.forEach((theme, index) => {
    const path = `/contributes/themes/${index}`;
    if (!theme.dark && !theme.light)
      issue(path, "a theme needs dark or light values");
    for (const appearance of ["dark", "light"] as const)
      for (const [token, color] of Object.entries(theme[appearance] ?? {})) {
        // A newer app may let themes set more; this one leaves those alone.
        if (!tokens.has(token)) {
          ignored.push({ path: `${path}/${appearance}/${token}`, message: `${token} ${IGNORED}` });
          delete theme[appearance]![token];
        } else if (!COLOR.test(color.trim()))
          issue(`${path}/${appearance}/${token}`, "must be a colour");
      }
  });
  // A theme left with nothing this app knows would change nothing when picked.
  const emptyThemes = new Set(contributes.themes?.filter((theme) => (theme.dark || theme.light) && !Object.keys({ ...theme.dark, ...theme.light }).length));
  if (emptyThemes.size) {
    contributes.themes!.forEach((theme, index) => {
      if (emptyThemes.has(theme)) ignored.push({ path: `/contributes/themes/${index}`, message: "sets no colour this version of OhMyGame knows, so it's ignored" });
    });
    contributes.themes = contributes.themes!.filter((theme) => !emptyThemes.has(theme));
  }

  contributes.providers?.forEach((provider, index) => {
    const path = `/contributes/providers/${index}`;
    if (provider.apiKey) {
      const field = manifest.configuration?.[provider.apiKey];
      if (field?.type !== "secret")
        issue(`${path}/apiKey`, "must name a secret configuration field");
    }
    const chat = provider.api !== undefined || provider.baseUrl !== undefined;
    if (chat && (!provider.api || !provider.baseUrl))
      issue(path, "chat needs both api and baseUrl");
    if (chat && !provider.models && !provider.discoverModels)
      issue(path, "list models or discover them");
    if (!chat && (provider.models || provider.discoverModels))
      issue(path, "models and discoverModels are for chat, which needs api and baseUrl");
    if (!chat && !provider.media)
      issue(path, "a provider needs chat (api and baseUrl) or media");
    if (provider.media) {
      const media = provider.media;
      if (!media.image && !media.video && !media.audio && !media["3d"])
        issue(`${path}/media`, "list what it makes: image, video, audio or 3d");
      for (const kind of PLUGIN_MEDIA_KINDS) {
        media[kind]?.models.forEach((model, modelIndex) => {
          for (const [field, message] of mediaModelIssues(kind, model)) issue(`${path}/media/${kind}/models/${modelIndex}/${field}`, message);
        });
      }
      if (!capabilities.network?.length)
        issue(`${path}/media`, "media needs capabilities.network, the hosts its adapter reaches");
    }
  });

  const processes = new Set(capabilities.processes);
  contributes.agents?.forEach((agent, index) => {
    if (!processes.has(agent.command))
      issue(`/contributes/agents/${index}/command`, `${agent.command} must be listed in capabilities.processes`);
  });
  contributes.mcpServers?.forEach((server, index) => {
    const path = `/contributes/mcpServers/${index}`;
    if ("url" in server) {
      if (!capabilities.network?.length) issue(`${path}/url`, "an HTTP server needs capabilities.network");
      for (const name of configReferences(server.url)) {
        const field = manifest.configuration?.[name];
        if (!field) issue(`${path}/url`, `no configuration field ${name}`);
        else if (field.type === "secret") issue(`${path}/url`, `${name} is a secret, which a URL can't carry; send it in a header`);
      }
      for (const name of configReferences(server.headers)) {
        const field = manifest.configuration?.[name];
        if (!field) issue(`${path}/headers`, `no configuration field ${name}`);
        else if (field.type === "secret" && !capabilities.secrets)
          issue(`${path}/headers`, `${name} is a secret, which needs capabilities.secrets`);
      }
      // The URL as it starts, with its settings' defaults, must already be allowed.
      const initial = server.url.replace(/\$\{config\.([a-zA-Z0-9]+)\}/g, (match, name: string) => {
        const value = manifest.configuration?.[name]?.default;
        return typeof value === "string" ? value : match;
      });
      if (!configReferences(initial).length) {
        const problem = mcpUrlIssue(initial, capabilities.network);
        if (problem) issue(`${path}/url`, `${initial} ${problem}`);
      }
      return;
    }
    if (!processes.has(server.command))
      issue(`${path}/command`, `${server.command} must be listed in capabilities.processes`);
    const syntax = mcpServerSyntaxIssue(server);
    if (syntax) issue(path, syntax);
    if (server.env && Object.keys(server.env).some((key) => key.toUpperCase() === PLUGIN_DATA_ENV))
      issue(`${path}/env`, `${PLUGIN_DATA_ENV} is set by the app`);
    for (const name of configReferences(server)) {
      const field = manifest.configuration?.[name];
      if (!field) issue(path, `no configuration field ${name}`);
      else if (field.type === "secret" && !capabilities.secrets)
        issue(path, `${name} is a secret, which needs capabilities.secrets`);
    }
  });

  if (contributes.panels && !manifest.icon)
    issue("/icon", "a plugin with panels needs an icon for their tabs");

  return issues.length ? { ok: false, issues, ...notes() } : { ok: true, manifest, ...notes() };
}

/** What the MCP adapter would expand in a value: `${VAR}`, `$env:VAR` or `{env:VAR}`. */
/** The environment variable that gives a plugin's MCP servers its data folder. */
export const PLUGIN_DATA_ENV = "OHMYGAME_PLUGIN_DATA_DIR";

const ADAPTER_SYNTAX = /\$\{\w+\}|\$env:\w+|\{env:\w+\}/;

/**
 * Why an MCP server's values can't be handed to the adapter as they are, or
 * undefined. The adapter reads environment variables into `args` and `cwd`,
 * so a plugin, or a setting filled into one, could read the app's secrets.
 * `env` is passed literally, so its values may start with `!` or name
 * variables without the adapter acting on them.
 */
export function mcpServerSyntaxIssue(server: { args?: string[]; cwd?: string }): string | undefined {
  return [...(server.args ?? []), server.cwd].some((value) => value !== undefined && ADAPTER_SYNTAX.test(value))
    ? "args and cwd can't name environment variables"
    : undefined;
}

/** Hosts an HTTP MCP server may use plain HTTP with: those on this computer. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Whether `capabilities.network` covers a URL: an entry names a host exactly,
 * with any port, or `host:port` for that port alone (the URL's own, or 443 or
 * 80 by its scheme).
 */
export function networkCovers(network: readonly string[] | undefined, url: URL): boolean {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (network ?? []).some((entry) => {
    const [host, only] = entry.split(":");
    return host === url.hostname && (only === undefined || only === port);
  });
}

/**
 * Why an HTTP MCP server can't use a URL, or undefined: it must be https, or
 * http on this computer, carry no user name or password, and be on a host
 * `capabilities.network` lists.
 */
export function mcpUrlIssue(value: string, network: readonly string[] | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
    return "must use https, or http on this computer (127.0.0.1 or localhost)";
  if (url.username || url.password) return "can't carry a user name or password";
  if (!networkCovers(network, url)) return `is on ${url.host}, which capabilities.network doesn't list`;
  return undefined;
}

/** A copy of `value` with each `${config.field}` in its strings replaced by that field's value. */
export function fillConfigReferences<T>(value: T, values: Record<string, unknown>): T {
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === "string"
      ? item.replace(/\$\{config\.([a-zA-Z0-9]+)\}/g, (_match, name: string) => String(values[name]))
      : item,
  ) as T;
}

/** The configuration fields a value names as `${config.field}`, anywhere inside it. */
export function configReferences(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value ?? null).matchAll(/\$\{config\.([a-zA-Z0-9]+)\}/g)].map((match) => match[1]!))];
}

function semver(value: string) {
  if (!isPluginVersion(value)) return undefined;
  const [core, prerelease] = value.split("+")[0]!.split(/-(.*)/s);
  return { core: core!, prerelease: prerelease || undefined };
}

/**
 * Whether `version` falls in `range` (exact, ^x.y.z, ~x.y.z or >=x.y.z), as
 * npm reads them: build metadata is ignored, and a prerelease only matches
 * a range that names it exactly.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const match = /^(\^|~|>=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    range,
  );
  const parsed = semver(version);
  if (!match || !parsed) return false;
  const [, operator, major, minor, patch] = match;
  const base = `${major}.${minor}.${patch}`;
  if (!operator) return !parsed.prerelease && parsed.core === base;
  if (parsed.prerelease) return false;
  const atLeast = !isNewerPluginVersion(base, parsed.core);
  if (operator === ">=") return atLeast;
  const upper =
    operator === "~"
      ? `${major}.${Number(minor) + 1}.0`
      : major !== "0"
        ? `${Number(major) + 1}.0.0`
        : minor !== "0"
          ? `0.${Number(minor) + 1}.0`
          : `0.0.${Number(patch) + 1}`;
  return atLeast && isNewerPluginVersion(upper, parsed.core);
}

/** Why this host can't run a plugin, or undefined when it can. */
export function pluginApiIssue(
  manifest: Pick<PluginManifestV2, "engines">,
  hostApi = PLUGIN_HOST_API_VERSION,
): { message: string; fix: PluginVersionFix } | undefined {
  const range = manifest.engines["ohmygame-api"];
  if (satisfiesVersionRange(hostApi, range)) return undefined;
  const lowest = /\d+\.\d+\.\d+/.exec(range)?.[0];
  return lowest && isNewerPluginVersion(lowest, hostApi)
    ? {
        fix: "update-app",
        message: `This plugin needs a newer version of OhMyGame: plugin API ${range}, and this version has ${hostApi}. Update OhMyGame to use it.`,
      }
    : {
        fix: "update-plugin",
        message: `This plugin was made for an older version of OhMyGame: plugin API ${range}, and this version has ${hostApi}. Its author needs to update it.`,
      };
}

/** Why this version of the app can't show a plugin's pages, from the component major they declare. */
export function pluginUiIssue(
  manifest: Pick<PluginManifestV2, "ui">,
  served: readonly string[] = PLUGIN_UI_MAJORS,
  preview: ReadonlySet<string> = PLUGIN_UI_PREVIEW_MAJORS,
): { message: string; fix?: PluginVersionFix } | undefined {
  const major = manifest.ui?.major;
  if (major === undefined) return undefined;
  if (served.includes(String(major)))
    return preview.has(String(major)) && !manifest.ui?.preview
      ? { message: `Page components ${major} are in preview, so ui.preview must be true to use them` }
      : undefined;
  return major > Math.max(0, ...served.map(Number))
    ? {
        fix: "update-app",
        message: `This plugin needs a newer version of OhMyGame: its pages use page components ${major}. Update OhMyGame to use it.`,
      }
    : {
        fix: "update-plugin",
        message: `This plugin was made for an older version of OhMyGame: its pages use page components ${major}, which it no longer has. Its author needs to update it.`,
      };
}

/** Longest tool name the model APIs accept. */
export const AGENT_TOOL_NAME_MAX = 64;

/**
 * The name agents see for a plugin tool: unique across plugins, and within
 * the characters every model API allows for tool names.
 */
export function agentToolName(pluginId: string, tool: string): string {
  const [publisher, name] = pluginId.split("/");
  return `${publisher}__${name}__${tool}`;
}

/** Keywords a tool's input or output schema may use, with what each holds. */
const TOOL_SCHEMA_KEYWORDS: Record<
  string,
  | "schema"
  | "schemas"
  | "map"
  | "strings"
  | "string"
  | "number"
  | "boolean"
  | "any"
  | "type"
  | "array"
> = {
  type: "type",
  title: "string",
  description: "string",
  format: "string",
  pattern: "string",
  $ref: "string",
  properties: "map",
  $defs: "map",
  required: "strings",
  items: "schema",
  additionalProperties: "schema",
  anyOf: "schemas",
  oneOf: "schemas",
  allOf: "schemas",
  not: "schema",
  enum: "array",
  const: "any",
  default: "any",
  examples: "array",
  minimum: "number",
  maximum: "number",
  exclusiveMinimum: "number",
  exclusiveMaximum: "number",
  multipleOf: "number",
  minLength: "number",
  maxLength: "number",
  minItems: "number",
  maxItems: "number",
  minProperties: "number",
  maxProperties: "number",
  uniqueItems: "boolean",
};
const COUNT_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/**
 * Problems with a tool's JSON Schema: the root must describe an object, only
 * the keywords above are allowed, and `$ref` may only point inside the
 * document. Returns JSON Pointers with messages.
 */
export function toolSchemaIssues(schema: unknown): string[] {
  const issues: string[] = [];
  const refs: [string, string][] = [];
  const visit = (value: unknown, at: string, depth: number) => {
    if (depth > 20) return void issues.push(`${at} nests too deeply`);
    if (typeof value === "boolean") return;
    if (!value || typeof value !== "object" || Array.isArray(value))
      return void issues.push(`${at} must be a schema object`);
    for (const [keyword, child] of Object.entries(value)) {
      const where = `${at}/${keyword}`;
      const kind = TOOL_SCHEMA_KEYWORDS[keyword];
      if (!kind) issues.push(`${where} is not a supported keyword`);
      else if (kind === "schema") visit(child, where, depth + 1);
      else if (kind === "schemas") {
        if (!Array.isArray(child) || !child.length)
          issues.push(`${where} must be a non-empty array of schemas`);
        else
          child.forEach((item, index) =>
            visit(item, `${where}/${index}`, depth + 1),
          );
      } else if (kind === "map") {
        if (!child || typeof child !== "object" || Array.isArray(child))
          issues.push(`${where} must be an object of schemas`);
        else
          for (const [name, item] of Object.entries(child))
            visit(item, `${where}/${name}`, depth + 1);
      } else if (kind === "strings") {
        if (
          !Array.isArray(child) ||
          !child.every((item) => typeof item === "string")
        )
          issues.push(`${where} must be an array of strings`);
      } else if (kind === "array") {
        if (!Array.isArray(child)) issues.push(`${where} must be an array`);
      } else if (kind === "type") {
        const types = Array.isArray(child) ? child : [child];
        if (
          !types.length ||
          !types.every(
            (item) => typeof item === "string" && SCHEMA_TYPES.has(item),
          )
        )
          issues.push(`${where} must name JSON types`);
      } else if (kind !== "any" && typeof child !== kind)
        issues.push(`${where} must be a ${kind}`);
      else if (kind === "number" && COUNT_KEYWORDS.has(keyword)) {
        if (!Number.isInteger(child) || (child as number) < 0)
          issues.push(`${where} must be a non-negative integer`);
      } else if (keyword === "multipleOf" && !((child as number) > 0))
        issues.push(`${where} must be greater than 0`);
      if (
        keyword === "$ref" &&
        typeof child === "string" &&
        child.startsWith("#")
      )
        refs.push([where, child]);
      if (
        keyword === "$ref" &&
        typeof child === "string" &&
        !child.startsWith("#")
      )
        issues.push(`${where} may only point inside the schema`);
      if (keyword === "pattern" && typeof child === "string") {
        try {
          new RegExp(child, "u");
        } catch {
          issues.push(`${where} is not a valid pattern`);
        }
      }
    }
  };
  visit(schema, "", 0);
  // Local references must point at something in the document.
  for (const [where, ref] of refs) {
    let target: unknown = schema;
    for (const part of ref.slice(1).split("/").slice(1)) {
      const name = decodeURIComponent(part)
        .replace(/~1/g, "/")
        .replace(/~0/g, "~");
      target =
        target && typeof target === "object" && Object.hasOwn(target, name)
          ? (target as Record<string, unknown>)[name]
          : undefined;
    }
    if (target === undefined || (ref !== "#" && !ref.startsWith("#/")))
      issues.push(`${where} points at nothing in the schema`);
  }
  if (!issues.length && (schema as { type?: unknown }).type !== "object")
    issues.push("/type must be object");
  return issues;
}
