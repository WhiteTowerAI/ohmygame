/** How much of a tool's output a conversation shows: half from its start and half from its end. */
export const MAX_TOOL_OUTPUT = 12_000;

/** Shortens output to what is shown. Text it already shortened comes back unchanged. */
export function boundToolOutput(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT) return value;
  const half = MAX_TOOL_OUTPUT / 2;
  return `${value.slice(0, half)}\n\n... output truncated ...\n\n${value.slice(-half)}`;
}
