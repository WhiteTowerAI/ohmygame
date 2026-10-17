import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { FastifyInstance } from "fastify";
import {
  PERSONAL_MARKETPLACE,
  PLUGIN_ARCHIVE_MAX_BYTES,
  PLUGIN_FORMAT_VERSION,
  PLUGIN_MANIFEST_PATH,
  pluginCollection,
} from "../shared/plugins.js";
import type {
  PluginArchivePreview,
  PluginPortableSettings,
} from "../shared/plugin-portability.js";
import {
  LocalPluginError,
  LocalPluginStore,
  assertPluginCompatible,
  inspectPluginBundle,
  readPluginManifest,
} from "./local-plugins.js";
import type { PluginCatalogService } from "./plugin-catalog.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import type { PluginSettingsStore } from "./plugin-settings.js";
import { inspectPluginFiles } from "./plugin-draft.js";
import { extractPluginArchive } from "./plugin-installer.js";
import { createPluginArchive } from "./publish/archive.js";
import { inspectPluginDependencies } from "./plugin-dependencies.js";

const BACKUP_PATH = ".ohmygame-plugin/backup.json";
const BackupSchema = Type.Object(
  {
    version: Type.Literal(1),
    marketplace: Type.Object(
      {
        id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
        displayName: Type.String({ minLength: 1 }),
        visibility: Type.Optional(
          Type.Union([Type.Literal("public"), Type.Literal("personal")]),
        ),
      },
      { additionalProperties: false },
    ),
    settings: Type.Object(
      {
        enabled: Type.Boolean(),
        components: Type.Record(Type.String(), Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    values: Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Boolean()]),
    ),
  },
  { additionalProperties: false },
);

export class PluginPortability {
  constructor(
    private readonly local: LocalPluginStore,
    private readonly capabilities: PluginCapabilities,
    private readonly settings: PluginSettingsStore,
  ) {}

  async export(id: string): Promise<Buffer> {
    let plugin = await this.local.read(id);
    if (!plugin || pluginCollection(plugin) !== "personal")
      throw new LocalPluginError("Select an installed Personal plugin", 404);
    const temporary = await mkdtemp(
      path.join(tmpdir(), "ohmygame-plugin-export-"),
    );
    const root = path.join(temporary, "plugin");
    try {
      const copied = await this.local.copyForAuthoring(id, root);
      plugin = await this.local.read(id);
      if (!plugin)
        throw new LocalPluginError(
          "The installed plugin changed. Export it again",
          409,
        );
      const manifest = await readPluginManifest(root);
      const { fields, definitions } =
        await this.capabilities.portableTemplates(plugin);
      manifest.formatVersion = PLUGIN_FORMAT_VERSION;
      manifest.configuration = fields;
      if (manifest.mcpServers)
        await writeFile(
          path.resolve(root, manifest.mcpServers),
          JSON.stringify({ mcpServers: definitions }, null, 2),
        );
      // copyForAuthoring already removed imported manifests, which can contain
      // inline credentials; this writes the redacted native manifest.
      await writeFile(
        path.join(root, PLUGIN_MANIFEST_PATH),
        JSON.stringify(manifest, null, 2),
      );
      const view = this.capabilities.configuration.view(plugin);
      const backup: PluginPortableSettings = {
        version: 1,
        marketplace: plugin.marketplace,
        settings: this.settings.resolve(plugin),
        values: Object.fromEntries(
          Object.entries(view.values).filter(
            ([key]) => fields[key]?.type !== "secret",
          ),
        ),
      };
      await writeFile(
        path.join(root, BACKUP_PATH),
        JSON.stringify(backup, null, 2),
      );
      const bytes = await createPluginArchive(
        root,
        PLUGIN_ARCHIVE_MAX_BYTES,
        true,
      );
      if (bytes.length > PLUGIN_ARCHIVE_MAX_BYTES)
        throw new LocalPluginError("Plugin archive is larger than 50 MB");
      const preview = await this.#inspect(bytes, false);
      if (
        JSON.stringify(preview.plugin.skills.map((skill) => skill.id)) !==
        JSON.stringify(plugin.skills.map((skill) => skill.id))
      )
        throw new LocalPluginError(
          "Plugin archive is missing declared resources",
        );
      const installedPath = await this.local.installedPath(id);
      if (
        !installedPath ||
        (await inspectPluginFiles(installedPath)).revision !== copied.revision
      )
        throw new LocalPluginError(
          "The installed plugin changed. Export it again",
          409,
        );
      return bytes;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  inspect(bytes: Buffer): Promise<PluginArchivePreview> {
    return this.#inspect(bytes, true);
  }

  #inspect(bytes: Buffer, enforceCompatibility: boolean): Promise<PluginArchivePreview> {
    return this.#archive(bytes, (root, backup) => this.#preview(root, backup, enforceCompatibility));
  }

  async #preview(
    root: string,
    backup?: PluginPortableSettings,
    enforceCompatibility = true,
  ): Promise<PluginArchivePreview> {
    const manifest = await readPluginManifest(root);
    if (enforceCompatibility) assertPluginCompatible(manifest);
    // Archives are user imports, even if their metadata was copied from a
    // catalog entry that was marked public.
    const marketplace = backup?.marketplace
      ? { ...backup.marketplace, visibility: "personal" as const }
      : PERSONAL_MARKETPLACE;
    if (marketplace.id === "ohmygame")
      throw new LocalPluginError(
        "An imported archive must be a Personal plugin",
      );
    const idPrefix =
      marketplace.id === "personal"
        ? "personal:"
        : `marketplace:${marketplace.id}:`;
    const plugin = {
      ...(await inspectPluginBundle(
        root,
        { idPrefix, marketplace, source: { type: "archive" } },
        manifest,
      )),
      // The preview describes the package in the archive. Installation state
      // is represented separately by existingRevision.
      installed: false,
    };
    if (backup) {
      const valid = this.settings.resolve(plugin).components;
      if (
        Object.keys(backup.settings.components).some(
          (key) => !Object.hasOwn(valid, key),
        )
      )
        throw new LocalPluginError("Backup contains unknown plugin components");
      for (const [key, value] of Object.entries(backup.values)) {
        const field = manifest.configuration?.[key];
        if (
          !field ||
          field.type === "secret" ||
          (field.type === "boolean"
            ? typeof value !== "boolean"
            : typeof value !== "string") ||
          (field.type === "select" && !field.options?.includes(String(value)))
        )
          throw new LocalPluginError(
            "Backup contains invalid or secret configuration values",
          );
      }
    }
    const installedPath = await this.local.installedPath(plugin.id);
    return {
      plugin,
      marketplace,
      restoresSettings: Boolean(backup),
      existingRevision: installedPath
        ? (await inspectPluginFiles(installedPath)).revision
        : undefined,
    };
  }

  async restore(bytes: Buffer, expectedRevision?: string) {
    return this.#archive(bytes, async (root, backup) => {
      const preview = await this.#preview(root, backup);
      const plugin = await this.local.installPortable(
        root,
        preview.marketplace,
        expectedRevision,
      );
      if (backup) {
        try {
          await this.capabilities.configuration.restorePortable(
            plugin,
            backup.values,
          );
          await this.settings.update(plugin, backup.settings);
        } catch (cause) {
          throw new LocalPluginError(
            `Plugin installed, but its settings could not be restored: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
      return this.settings.decorate(plugin);
    });
  }

  async #archive<T>(
    bytes: Buffer,
    action: (root: string, backup?: PluginPortableSettings) => Promise<T>,
  ): Promise<T> {
    if (
      !Buffer.isBuffer(bytes) ||
      !bytes.length ||
      bytes.length > PLUGIN_ARCHIVE_MAX_BYTES
    )
      throw new LocalPluginError("Choose a ZIP plugin archive up to 50 MB");
    const temporary = await mkdtemp(
      path.join(tmpdir(), "ohmygame-plugin-import-"),
    );
    try {
      const root = path.join(temporary, "plugin");
      await mkdir(root);
      const archivePath = path.join(temporary, "plugin.zip");
      await writeFile(archivePath, bytes);
      await extractPluginArchive(archivePath, root);
      let backup: PluginPortableSettings | undefined;
      try {
        const value: unknown = JSON.parse(
          await readFile(path.join(root, BACKUP_PATH), "utf8"),
        );
        if (!Check(BackupSchema, value))
          throw new LocalPluginError(
            "Plugin backup format is invalid or unsupported",
          );
        backup = value as PluginPortableSettings;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      return await action(root, backup);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

export function registerPluginPortabilityRoutes(
  app: FastifyInstance,
  options: {
    local: LocalPluginStore;
    plugins: PluginCatalogService;
    capabilities: PluginCapabilities;
    settings: PluginSettingsStore;
    invalidate: () => void;
  },
) {
  const portability = new PluginPortability(
    options.local,
    options.capabilities,
    options.settings,
  );
  app.addContentTypeParser(
    "application/zip",
    { parseAs: "buffer", bodyLimit: PLUGIN_ARCHIVE_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  const fail = (reply: import("fastify").FastifyReply, cause: unknown) =>
    reply
      .code(cause instanceof LocalPluginError ? cause.statusCode : 400)
      .send({ error: cause instanceof Error ? cause.message : String(cause) });
  app.get<{ Params: { pluginId: string } }>(
    "/plugins/:pluginId/export",
    async (request, reply) => {
      try {
        return reply
          .header("Cache-Control", "no-store")
          .type("application/zip")
          .header("Content-Disposition", "attachment; filename=plugin.zip")
          .send(await portability.export(request.params.pluginId));
      } catch (cause) {
        return fail(reply, cause);
      }
    },
  );
  app.post<{ Body: Buffer }>(
    "/plugins/import/inspect",
    { bodyLimit: PLUGIN_ARCHIVE_MAX_BYTES },
    async (request, reply) => {
      try {
        return await portability.inspect(request.body);
      } catch (cause) {
        return fail(reply, cause);
      }
    },
  );
  app.post<{ Body: Buffer; Querystring: { revision?: string } }>(
    "/plugins/import",
    {
      bodyLimit: PLUGIN_ARCHIVE_MAX_BYTES,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            revision: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply
          .code(201)
          .send(
            await portability.restore(request.body, request.query.revision),
          );
      } catch (cause) {
        return fail(reply, cause);
      } finally {
        options.invalidate();
      }
    },
  );
  app.get<{ Params: { pluginId: string } }>(
    "/plugins/:pluginId/dependencies",
    async (request, reply) => {
      try {
        const plugin = await options.plugins.read(request.params.pluginId);
        if (!plugin) throw new LocalPluginError("Plugin not found", 404);
        return await inspectPluginDependencies(plugin, options.capabilities);
      } catch (cause) {
        return fail(reply, cause);
      }
    },
  );
}
