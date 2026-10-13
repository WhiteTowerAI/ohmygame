export interface PreviewDiagnostic {
  kind: "compile" | "runtime" | "load";
  message: string;
  client?: string;
  source?: "editor" | "player" | "playtest" | "external";
  path?: string;
}

export const MAX_PREVIEW_DIAGNOSTIC_LENGTH = 8_192;

export function previewDiagnostic(
  value: unknown,
): PreviewDiagnostic | undefined {
  if (!value || typeof value !== "object") return;
  const { kind, message } = value as Partial<PreviewDiagnostic>;
  if (
    (kind !== "compile" && kind !== "runtime" && kind !== "load") ||
    typeof message !== "string" ||
    !message.trim()
  )
    return;
  return { kind, message: message.slice(0, MAX_PREVIEW_DIAGNOSTIC_LENGTH) };
}
