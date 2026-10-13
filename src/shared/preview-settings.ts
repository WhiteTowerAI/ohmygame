export const PREVIEW_MODES = ["auto", "script", "static", "command"] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];

export interface ProjectPreviewSettings {
  previewAutoStart?: boolean;
  previewMode?: PreviewMode;
  previewCommand?: string;
  previewArguments?: string[];
  previewPort?: number;
  /** Zero keeps unused previews running; otherwise minutes before stopping. */
  previewIdleMinutes?: number;
}

export const PREVIEW_SETTING_KEYS = [
  "previewAutoStart",
  "previewMode",
  "previewCommand",
  "previewArguments",
  "previewPort",
  "previewIdleMinutes",
] as const;

export function previewSettings(
  input: ProjectPreviewSettings,
): ProjectPreviewSettings {
  return Object.fromEntries(
    PREVIEW_SETTING_KEYS.filter((key) => input[key] !== undefined).map(
      (key) => [key, input[key]],
    ),
  );
}

export function validatePreviewSettings(input: ProjectPreviewSettings): void {
  if (
    input.previewAutoStart !== undefined &&
    typeof input.previewAutoStart !== "boolean"
  )
    throw new Error("Automatic preview must be a boolean");
  if (
    input.previewMode !== undefined &&
    !PREVIEW_MODES.includes(input.previewMode)
  )
    throw new Error("Unsupported preview mode");
  if (
    input.previewCommand !== undefined &&
    (typeof input.previewCommand !== "string" ||
      input.previewCommand.length > 2_000 ||
      /[\x00\r\n]/.test(input.previewCommand))
  )
    throw new Error("Preview command must be a single line");
  if (input.previewMode === "command" && !input.previewCommand?.trim())
    throw new Error("Enter a command that starts a local web server");
  if (
    input.previewArguments !== undefined &&
    (!Array.isArray(input.previewArguments) ||
      input.previewArguments.length > 20 ||
      input.previewArguments.some(
        (arg) =>
          typeof arg !== "string" || arg.length > 500 || /[\x00\r\n]/.test(arg),
      ))
  )
    throw new Error("Preview arguments must be an array of up to 20 strings");
  if (
    input.previewPort !== undefined &&
    (!Number.isInteger(input.previewPort) ||
      input.previewPort < 1024 ||
      input.previewPort > 65535)
  )
    throw new Error("Preview port must be between 1024 and 65535");
  if (
    input.previewIdleMinutes !== undefined &&
    (!Number.isInteger(input.previewIdleMinutes) ||
      input.previewIdleMinutes < 0 ||
      input.previewIdleMinutes > 60)
  )
    throw new Error("Idle timeout must be between 0 and 60 minutes");
}

export function validPreviewSettings(input: ProjectPreviewSettings): boolean {
  try {
    validatePreviewSettings(input);
    return true;
  } catch {
    return false;
  }
}
