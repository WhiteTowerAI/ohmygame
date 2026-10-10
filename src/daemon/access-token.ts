import type { Readable } from "node:stream";

const MAX_TOKEN_CHARS = 4_096;

/**
 * Takes the access token the daemon was started with. The desktop app writes
 * it to stdin, because other processes of the same user can read a process's
 * start environment; a daemon started on its own may still be given it in
 * `OHMYGAME_DAEMON_TOKEN`. Either way it leaves the environment, which every
 * process the daemon starts inherits.
 */
export async function takeAccessToken(environment: NodeJS.ProcessEnv, input: Readable): Promise<string | undefined> {
  const fromEnvironment = environment.OHMYGAME_DAEMON_TOKEN;
  const fromInput = environment.OHMYGAME_DAEMON_TOKEN_STDIN === "1";
  delete environment.OHMYGAME_DAEMON_TOKEN;
  delete environment.OHMYGAME_DAEMON_TOKEN_STDIN;
  if (!fromInput) return fromEnvironment;
  let token = "";
  for await (const chunk of input.setEncoding("utf8")) {
    token += chunk;
    if (token.length > MAX_TOKEN_CHARS) throw new Error("The daemon access token is too long");
  }
  // An app that sends a token must never get a daemon that accepts requests without one.
  if (!token) throw new Error("The daemon access token was not received");
  return token;
}
