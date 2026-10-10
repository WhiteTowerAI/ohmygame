/**
 * App-owned native binaries must not override a project's own dependencies,
 * and the daemon's own settings, such as its access token, are not for
 * project code.
 */
export function projectProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ESBUILD_BINARY_PATH;
  for (const name of Object.keys(result)) {
    if (name.startsWith("OHMYGAME_") || name === "DAEMON_HOST" || name === "DAEMON_PORT") delete result[name];
  }
  return result;
}
