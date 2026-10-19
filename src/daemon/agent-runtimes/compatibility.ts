/** Keep a recognizable message when native drivers serialize errors into transcripts. */
export function agentCompatibilityError(name: string, detail: string): Error {
  return Object.assign(
    new Error(
      `${name} CLI compatibility check failed: ${detail} Update the CLI or choose another executable in Settings → Agents, then check again.`,
    ),
    { code: "AGENT_RUNTIME_INCOMPATIBLE" },
  );
}
