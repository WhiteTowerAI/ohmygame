import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

/** Load Vite's file precedence without replacing values supplied by the parent. */
export function loadEnvironmentFiles(
  directory: string,
  mode: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  for (const file of [
    `.env.${mode}.local`,
    `.env.${mode}`,
    ".env.local",
    ".env",
  ]) {
    try {
      const values = parse(readFileSync(path.join(directory, file)));
      for (const [key, value] of Object.entries(values)) {
        if (environment[key] === undefined) environment[key] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
