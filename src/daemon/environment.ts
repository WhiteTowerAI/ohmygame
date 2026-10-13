import path from "node:path";

/** Match Vite's precedence without replacing variables supplied by the parent. */
export function loadEnvironmentFiles(
  repositoryRoot: string,
  mode: "development" | "production",
): void {
  for (const file of [
    `.env.${mode}.local`,
    `.env.${mode}`,
    ".env.local",
    ".env",
  ]) {
    try {
      process.loadEnvFile(path.join(repositoryRoot, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
