import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironmentFiles } from "../src/shared/environment.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runtime preparation environment", () => {
  it("preserves parent values and uses Vite's mode-specific precedence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-env-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, ".env"),
      'SOURCE=base\nBASE_ONLY=yes\nPARENT=file\nMULTILINE="first\\nsecond"\n',
    );
    await writeFile(path.join(directory, ".env.local"), "SOURCE=local\n");
    await writeFile(
      path.join(directory, ".env.development"),
      "SOURCE=development\n",
    );
    await writeFile(
      path.join(directory, ".env.development.local"),
      "SOURCE=development-local\n",
    );
    const environment: NodeJS.ProcessEnv = { PARENT: "shell" };
    loadEnvironmentFiles(directory, "development", environment);
    expect(environment).toEqual({
      PARENT: "shell",
      SOURCE: "development-local",
      BASE_ONLY: "yes",
      MULTILINE: "first\nsecond",
    });
    const production: NodeJS.ProcessEnv = {};
    loadEnvironmentFiles(directory, "production", production);
    expect(production.SOURCE).toBe("local");
  });
});
