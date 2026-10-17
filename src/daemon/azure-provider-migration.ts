import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

// Pi 1.0.3 renamed this provider and does not move stored settings itself.
const LEGACY_ID = "azure-openai-responses";
const CURRENT_ID = "azure";

type JsonObject = Record<string, unknown>;

/**
 * Moves stored Azure sign-ins and settings to Pi's current provider ID.
 * Entries that already use the new ID win, so a repeated run changes nothing.
 */
export async function migrateAzureProviderId(
  piAgentDirectory: string,
  dataDirectory: string,
): Promise<void> {
  const results = await Promise.allSettled([
    updateJson(path.join(piAgentDirectory, "auth.json"), (config) =>
      renameKey(config, []),
    ),
    updateJson(path.join(piAgentDirectory, "models.json"), (config) =>
      renameKey(config, ["providers"]),
    ),
    updateJson(path.join(piAgentDirectory, "settings.json"), migratePiSettings),
    updateJson(
      path.join(dataDirectory, "model-visibility.json"),
      migrateVisibility,
    ),
  ]);
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Could not migrate some Azure provider settings",
    );
}

type Edit = { path: (string | number)[]; value: unknown };

function renameKey(config: JsonObject, parent: string[]): Edit[] {
  const container = parent.length ? config[parent[0]] : config;
  if (!isObject(container) || !Object.hasOwn(container, LEGACY_ID)) return [];
  const edits: Edit[] = [{ path: [...parent, LEGACY_ID], value: undefined }];
  if (!Object.hasOwn(container, CURRENT_ID))
    edits.unshift({
      path: [...parent, CURRENT_ID],
      value: container[LEGACY_ID],
    });
  return edits;
}

function renameModelPattern(value: string): string {
  return value.startsWith(`${LEGACY_ID}/`)
    ? `${CURRENT_ID}${value.slice(LEGACY_ID.length)}`
    : value;
}

function migratePiSettings(config: JsonObject): Edit[] {
  const edits: Edit[] = [];
  if (config.defaultProvider === LEGACY_ID)
    edits.push({ path: ["defaultProvider"], value: CURRENT_ID });
  if (
    Array.isArray(config.enabledModels) &&
    config.enabledModels.some(
      (item) => typeof item === "string" && renameModelPattern(item) !== item,
    )
  ) {
    edits.push({
      path: ["enabledModels"],
      value: config.enabledModels.map((item) =>
        typeof item === "string" ? renameModelPattern(item) : item,
      ),
    });
  }
  if (isObject(config.modelThinkingLevels)) {
    for (const [key, level] of Object.entries(config.modelThinkingLevels)) {
      const renamed = renameModelPattern(key);
      if (renamed === key) continue;
      edits.push({ path: ["modelThinkingLevels", key], value: undefined });
      if (!Object.hasOwn(config.modelThinkingLevels, renamed))
        edits.push({ path: ["modelThinkingLevels", renamed], value: level });
    }
  }
  return edits;
}

function migrateVisibility(config: JsonObject): Edit[] {
  const edits = [
    ...renameKey(config, ["hidden"]),
    ...renameKey(config, ["responsesTransports"]),
  ];
  if (Array.isArray(config.disabled) && config.disabled.includes(LEGACY_ID)) {
    edits.push({
      path: ["disabled"],
      value: [
        ...new Set(
          config.disabled.map((id) => (id === LEGACY_ID ? CURRENT_ID : id)),
        ),
      ],
    });
  }
  for (const key of [
    "defaultImageModel",
    "defaultVideoModel",
    "defaultModel3D",
  ]) {
    const model = config[key];
    if (isObject(model) && model.provider === LEGACY_ID)
      edits.push({ path: [key, "provider"], value: CURRENT_ID });
  }
  return edits;
}

/** Applies edits in place so comments and formatting in user-edited files survive. */
async function updateJson(
  filePath: string,
  migrate: (config: JsonObject) => Edit[],
): Promise<void> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  if (!text.includes(LEGACY_ID)) return;
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  text = text.slice(bom.length);
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !isObject(config))
    throw new Error(
      `Could not migrate Azure settings in invalid ${path.basename(filePath)}`,
    );
  const edits = migrate(config);
  if (!edits.length) return;
  let next = text;
  for (const edit of edits)
    next = applyEdits(
      next,
      modify(next, edit.path, edit.value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    );
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bom + next, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
