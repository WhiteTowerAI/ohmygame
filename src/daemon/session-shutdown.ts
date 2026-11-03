import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** How long a session's extensions get to shut down before it is disposed of anyway. */
export const EXTENSION_SHUTDOWN_MS = 5_000;

/**
 * Stops a session's work and tells its extensions it is over. An extension
 * that never finishes must not keep a conversation or the daemon waiting.
 */
export async function shutDownExtensions(session: Pick<AgentSession, "abort" | "extensionRunner">): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await session.abort();
    await Promise.race([
      session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
      new Promise((resolve) => { timer = setTimeout(resolve, EXTENSION_SHUTDOWN_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pi's own `dispose` does not tell extensions a session is over, and what an
 * extension keeps listening with can hold the session's whole transcript in
 * memory. Disposing then returns a promise that settles once it is gone.
 */
export function shutDownExtensionsOnDispose(session: Pick<AgentSession, "abort" | "dispose" | "extensionRunner">): void {
  const dispose = session.dispose.bind(session);
  let closing: Promise<void> | undefined;
  session.dispose = () => (closing ??= (async () => {
    try {
      await shutDownExtensions(session);
    } catch {
      console.warn("Could not shut down a session's extensions");
    } finally {
      dispose();
    }
  })());
}
