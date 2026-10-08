/** App-owned native binaries must not override a project's own dependencies. */
export function projectProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...environment };
  delete result.ESBUILD_BINARY_PATH;
  return result;
}
