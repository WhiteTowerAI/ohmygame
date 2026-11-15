/** JSON settings and the combined image configuration snapshot share this byte budget. */
export const PLUGIN_JSON_MAX_BYTES = 256 * 1024;

/** Keep the source string in settings; adapters receive the parsed object. */
export function parsePluginJson(text: string): Record<string, unknown> {
  if (new TextEncoder().encode(text).length > PLUGIN_JSON_MAX_BYTES)
    throw new Error("JSON must be at most 256 KiB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Enter a valid JSON object");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Enter a JSON object, not an array or a scalar");
  return value as Record<string, unknown>;
}
