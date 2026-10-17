import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAzureProviderId } from "../src/daemon/azure-provider-migration.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-azure-migration-"),
  );
  directories.push(directory);
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(directory, name), text);
  return directory;
}

const read = async (directory: string, name: string) =>
  JSON.parse(await readFile(path.join(directory, name), "utf8")) as unknown;

describe("Azure provider migration", () => {
  it("moves sign-ins, model config, Pi settings, and model preferences to the azure provider", async () => {
    const directory = await fixture({
      "auth.json": JSON.stringify({
        "azure-openai-responses": { type: "api_key", key: "secret" },
        openai: { type: "api_key", key: "other" },
      }),
      "models.json": `{
  // Deployment set up by hand
  "providers": { "azure-openai-responses": { "baseUrl": "https://example.openai.azure.com" } },
}
`,
      "settings.json": JSON.stringify({
        defaultProvider: "azure-openai-responses",
        enabledModels: ["azure-openai-responses/gpt-5", "openai/*"],
        modelThinkingLevels: { "azure-openai-responses/gpt-5": "high" },
      }),
      "model-visibility.json": JSON.stringify({
        version: 1,
        hidden: { "azure-openai-responses": ["gpt-4"] },
        disabled: ["azure-openai-responses"],
        responsesTransports: { "azure-openai-responses": "sse" },
        defaultImageModel: {
          provider: "azure-openai-responses",
          id: "gpt-image-1",
        },
      }),
    });
    await migrateAzureProviderId(directory, directory);

    expect(await read(directory, "auth.json")).toEqual({
      azure: { type: "api_key", key: "secret" },
      openai: { type: "api_key", key: "other" },
    });
    const models = await readFile(path.join(directory, "models.json"), "utf8");
    expect(models).toContain("// Deployment set up by hand");
    expect(models).toContain('"azure": {');
    expect(models).not.toContain("azure-openai-responses");
    expect(await read(directory, "settings.json")).toEqual({
      defaultProvider: "azure",
      enabledModels: ["azure/gpt-5", "openai/*"],
      modelThinkingLevels: { "azure/gpt-5": "high" },
    });
    expect(await read(directory, "model-visibility.json")).toEqual({
      version: 1,
      hidden: { azure: ["gpt-4"] },
      disabled: ["azure"],
      responsesTransports: { azure: "sse" },
      defaultImageModel: { provider: "azure", id: "gpt-image-1" },
    });
  });

  it("keeps entries already stored under the azure provider", async () => {
    const directory = await fixture({
      "auth.json": JSON.stringify({
        "azure-openai-responses": { type: "api_key", key: "old" },
        azure: { type: "api_key", key: "new" },
      }),
    });
    await migrateAzureProviderId(directory, directory);
    await migrateAzureProviderId(directory, directory);
    expect(await read(directory, "auth.json")).toEqual({
      azure: { type: "api_key", key: "new" },
    });
  });

  it("ignores missing files and leaves files without the old provider untouched", async () => {
    const settings = '{ "defaultProvider": "openai" }';
    const directory = await fixture({ "settings.json": settings });
    await migrateAzureProviderId(directory, directory);
    expect(await readFile(path.join(directory, "settings.json"), "utf8")).toBe(
      settings,
    );
  });

  it("preserves UTF-8 BOMs and JSONC comments while migrating Pi files", async () => {
    const files = {
      "auth.json":
        '\uFEFF{ "azure-openai-responses": { "type": "api_key", "key": "secret" } }',
      "models.json":
        '\uFEFF{ // Deployment\n "providers": { "azure-openai-responses": { "baseUrl": "https://example.openai.azure.com" } },\n}',
      "settings.json": '\uFEFF{ "defaultProvider": "azure-openai-responses" }',
    };
    const directory = await fixture(files);
    await migrateAzureProviderId(directory, directory);
    for (const name of Object.keys(files)) {
      const text = await readFile(path.join(directory, name), "utf8");
      expect(text.startsWith("\uFEFF")).toBe(true);
      expect(text).not.toContain("azure-openai-responses");
      expect(text).toContain('"azure"');
    }
    expect(
      await readFile(path.join(directory, "models.json"), "utf8"),
    ).toContain("// Deployment");
    const migrated = await Promise.all(
      Object.keys(files).map((name) =>
        readFile(path.join(directory, name), "utf8"),
      ),
    );
    await migrateAzureProviderId(directory, directory);
    expect(
      await Promise.all(
        Object.keys(files).map((name) =>
          readFile(path.join(directory, name), "utf8"),
        ),
      ),
    ).toEqual(migrated);
  });

  it.each(["auth.json", "settings.json"])(
    "migrates healthy files even when %s is invalid",
    async (invalidFile) => {
      const invalid = '{ "azure-openai-responses": ';
      const directory = await fixture({
        "auth.json": JSON.stringify({
          "azure-openai-responses": { type: "api_key", key: "secret" },
        }),
        "models.json": JSON.stringify({
          providers: {
            "azure-openai-responses": {
              baseUrl: "https://example.openai.azure.com",
            },
          },
        }),
        "settings.json": JSON.stringify({
          defaultProvider: "azure-openai-responses",
        }),
        "model-visibility.json": JSON.stringify({
          hidden: { "azure-openai-responses": ["gpt-4"] },
          disabled: ["azure-openai-responses"],
        }),
        [invalidFile]: invalid,
      });
      await expect(
        migrateAzureProviderId(directory, directory),
      ).rejects.toThrow();
      expect(await readFile(path.join(directory, invalidFile), "utf8")).toBe(
        invalid,
      );
      expect(await read(directory, "models.json")).toEqual({
        providers: { azure: { baseUrl: "https://example.openai.azure.com" } },
      });
      expect(await read(directory, "model-visibility.json")).toEqual({
        hidden: { azure: ["gpt-4"] },
        disabled: ["azure"],
      });
      if (invalidFile !== "auth.json")
        expect(await read(directory, "auth.json")).toEqual({
          azure: { type: "api_key", key: "secret" },
        });
    },
  );
});
