import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";
import { CUSTOM_MODEL_APIS } from "./contracts.js";
import { isNewerPluginVersion, isPluginVersion } from "./plugins.js";
import { compileWhen } from "./plugin-when.js";

// Plugin format 2: the manifest at `.ohmygame-plugin/plugin.json`, read at
// install time without running any plugin code. The TypeBox schemas below
// are the source of the published JSON Schema (`schemas/plugin-2.json`), and
// `validatePluginManifest` adds the rules a schema can't express.

export const PLUGIN_MANIFEST_SCHEMA_URL =
  "https://ohmygame.dev/schema/plugin-2.json";
/** The plugin API this host implements; manifests name the range they need. */
export const PLUGIN_HOST_API_VERSION = "2.0.0";

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

export const PLUGIN_CATEGORIES = [
  "engine",
  "art",
  "audio",
  "publishing",
  "provider",
  "theme",
  "workflow",
  "integration",
] as const;

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
    agent: Type.Optional(Type.Boolean()),
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
    ready: Type.Optional(
      Type.Object(
        {
          command: Slug,
          panel: Slug,
        },
        {
          additionalProperties: false,
          description:
            "Before a prompt is sent in a project of this type, the app runs this native command (no input), which returns { ready, message? }; when not ready, the prompt waits and the panel opens",
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

const Provider = Type.Object(
  {
    id: Slug,
    title: Text(),
    icon: Type.Optional(Icon),
    api: Literals(CUSTOM_MODEL_APIS),
    baseUrl: HttpsUrl,
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
  },
  { additionalProperties: false },
);

/** A string that may name configuration values as `${config.field}`. */
const Template = (maxLength = 2000) => Type.String({ maxLength });

/**
 * An MCP server the plugin brings: a process (`command`, run from the
 * plugin's folder unless `cwd` says otherwise). Agents see only the `tools`
 * it names. HTTP servers wait for a way to keep redirects within
 * `capabilities.network`, which the MCP adapter doesn't offer.
 */
const McpServer = Type.Object(
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

const list = <T extends Parameters<typeof Type.Array>[0]>(item: T) =>
  Type.Optional(Type.Array(item, { minItems: 1, maxItems: 50 }));

const PLUGIN_ID_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*$";

/** Whether `id` is a format 2 plugin id, `publisher/name`, safe to use as a path. */
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
    categories: Type.Optional(
      Type.Array(Literals(PLUGIN_CATEGORIES), {
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      }),
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
          tools: list(Tool),
          commands: list(Command),
          settings: Type.Optional(Settings),
          themes: list(Theme),
          providers: list(Provider),
          panels: list(Panel),
          mcpServers: list(McpServer),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type PluginManifestV2 = Static<typeof PluginManifestV2Schema>;
export type PluginContributions = NonNullable<PluginManifestV2["contributes"]>;

export interface PluginManifestIssue {
  /** JSON Pointer into the manifest, such as `/contributes/themes/0/dark`. */
  path: string;
  message: string;
}

export type PluginManifestResult =
  | { ok: true; manifest: PluginManifestV2 }
  | { ok: false; issues: PluginManifestIssue[] };

/** A CSS colour a theme value may be: hex, or an rgb/hsl/oklch function. */
const COLOR =
  /^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([0-9.,%\s/+-]+\))$/;

/** Checks a manifest against the schema and the rules it can't express. */
export function validatePluginManifest(value: unknown): PluginManifestResult {
  const schemaIssues = [...Errors(PluginManifestV2Schema, value)]
    .filter((error) => error.keyword !== "boolean")
    .map((error) => ({
      path: error.instancePath,
      message: error.message,
    }));
  if (schemaIssues.length) return { ok: false, issues: schemaIssues };
  const manifest = value as PluginManifestV2;
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
    "panels",
    "mcpServers",
  ] as const) {
    const seen = new Set<string>();
    contributes[key]?.forEach((item, index) => {
      if (seen.has(item.id))
        issue(`/contributes/${key}/${index}/id`, `duplicate id ${item.id}`);
      seen.add(item.id);
    });
  }
  const toolNames = new Set<string>();
  contributes.tools?.forEach((tool, index) => {
    if (toolNames.has(tool.name))
      issue(`/contributes/tools/${index}/name`, `duplicate tool ${tool.name}`);
    toolNames.add(tool.name);
  });
  if (contributes.tools && !native)
    issue("/contributes/tools", "tools run in the native entrypoint");
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
    });
    if (command.slash) {
      if (slashes.has(command.slash))
        issue(`${path}/slash`, `duplicate slash command ${command.slash}`);
      slashes.add(command.slash);
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
        if (!tokens.has(token))
          issue(`${path}/${appearance}/${token}`, "not a theme token");
        else if (!COLOR.test(color.trim()))
          issue(`${path}/${appearance}/${token}`, "must be a colour");
      }
  });

  contributes.providers?.forEach((provider, index) => {
    const path = `/contributes/providers/${index}`;
    if (provider.apiKey) {
      const field = manifest.configuration?.[provider.apiKey];
      if (field?.type !== "secret")
        issue(`${path}/apiKey`, "must name a secret configuration field");
    }
    if (!provider.models && !provider.discoverModels)
      issue(path, "list models or discover them");
  });

  const processes = new Set(capabilities.processes);
  contributes.mcpServers?.forEach((server, index) => {
    const path = `/contributes/mcpServers/${index}`;
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

  return issues.length ? { ok: false, issues } : { ok: true, manifest };
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
): string | undefined {
  const range = manifest.engines["ohmygame-api"];
  return satisfiesVersionRange(hostApi, range)
    ? undefined
    : `Plugin needs OhMyGame plugin API ${range} (this version has ${hostApi})`;
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
