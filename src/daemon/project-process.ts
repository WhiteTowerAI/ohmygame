/**
 * App-owned native binaries must not override a project's own dependencies,
 * and the daemon's own settings, such as its access token, are not for
 * project code.
 */
export function projectProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ESBUILD_BINARY_PATH;
  for (const name of Object.keys(result)) {
    const key = name.toUpperCase();
    if (key.startsWith("OHMYGAME_") || key === "DAEMON_HOST" || key === "DAEMON_PORT") delete result[name];
  }
  return result;
}
