import { isDeepStrictEqual } from "node:util";
import type { Native3DProviderId } from "../shared/model3d-presets.js";
import type {
  PluginMediaModels,
  PluginMediaProcessingModel,
} from "../shared/plugin-manifest.js";
import type { Model3DReferenceMigration } from "./media-model-migration.js";
import { MODEL3D_MIGRATION_PACKAGES } from "./model3d-migration-package.js";
import {
  model3DSettingsFiles,
  proposeModel3DSettings,
} from "./model3d-migration-settings.js";
import { createSettingsTransaction } from "./media-settings-transaction.js";
import type { Snapshot } from "./media-settings-snapshot.js";

interface ReferenceRecord extends Model3DReferenceMigration {
  version: 1;
  release: { id: string; version: string; digest: string };
}

const referenceFile = (provider: Native3DProviderId) =>
  `.${provider}-model-references-v1.json`;
export const model3DTransactionFiles = (provider: Native3DProviderId) => [
  ...model3DSettingsFiles(provider),
  referenceFile(provider),
];

/** Prepared for an exclusive startup owner; does not install, enable or retire any provider. */
export function model3DSettingsTransaction(provider: Native3DProviderId) {
  const transaction = createSettingsTransaction({
    files: model3DTransactionFiles(provider),
    source: `${provider}.json`,
    journal: `.${provider}-settings-transaction.json`,
    backup: `.${provider}-settings-committed-v1.json`,
    label: provider,
  });
  const { committedSettingsFile, ...operations } = transaction;
  return {
    ...operations,
    async committedReferences(
      directory: string,
    ): Promise<Model3DReferenceMigration | undefined> {
      const entry = await committedSettingsFile(
        directory,
        referenceFile(provider),
      );
      if (!entry) return undefined;
      const { source, target, models, processing } = parseReferences(
        entry.bytes,
        provider,
      );
      return { source, target, models, ...(processing ? { processing } : {}) };
    },
  };
}

/**
 * Caller supplies models from the exact reviewed package after verifying its bytes.
 * The same proposal owns settings and reference identities; neither may commit alone.
 */
export async function proposeModel3DTransaction(
  original: Snapshot,
  provider: Native3DProviderId,
  media: {
    models: readonly PluginMediaModels["3d"][];
    processing?: PluginMediaProcessingModel;
  },
) {
  const plan = await proposeModel3DSettings(
    original,
    provider,
    media.models,
    media.processing?.id,
  );
  const blocked = (reason: string) => ({
    report: { ...plan.report, blockers: [...plan.report.blockers, reason] },
    changes: new Map() as Snapshot,
    counts: plan.counts,
  });
  if (plan.report.blockers.length)
    return { ...plan, changes: new Map() as Snapshot };
  const pin = MODEL3D_MIGRATION_PACKAGES.find(
    (entry) => entry.provider === provider,
  );
  if (!pin) return blocked("plugin-release-not-reviewed");
  const record: ReferenceRecord = {
    version: 1,
    source: provider,
    target: `plugin.ohmygame.${provider}.${provider}`,
    release: { id: pin.id, version: pin.version, digest: pin.digest },
    models: plan.references!,
    ...(media.processing
      ? {
          processing: {
            id: media.processing.id,
            operations: [...media.processing.operations],
          },
        }
      : {}),
  };
  const file = referenceFile(provider);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  try {
    parseReferences(bytes, provider);
    const previous = original.get(file);
    if (
      previous !== undefined &&
      !isDeepStrictEqual(parseReferences(previous, provider), record)
    )
      return blocked("reference-mapping-conflict");
    const changes: Snapshot = new Map(plan.changes);
    if (previous === undefined) changes.set(file, bytes);
    return { report: plan.report, changes, counts: plan.counts };
  } catch {
    return blocked("reference-mapping-unreadable");
  }
}

// compat: since beta.5.8, remove from beta.7 and 2026-12-15. Read the sealed
// migration mapping even when its sidecar, original models or plugin are gone.
function parseReferences(
  bytes: Buffer | undefined,
  provider: Native3DProviderId,
): ReferenceRecord {
  const invalid = () => new Error("Invalid committed 3D reference mapping");
  let value: unknown;
  try {
    value = bytes && JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  const object = (entry: unknown): entry is Record<string, unknown> =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry);
  const fields = (entry: Record<string, unknown>, keys: string[]) =>
    Object.keys(entry).length === keys.length &&
    keys.every((key) => Object.hasOwn(entry, key));
  const identity = (entry: unknown, operations: readonly string[]) => {
    if (!object(entry) || !fields(entry, ["id", "operations"])) return false;
    return (
      typeof entry.id === "string" &&
      entry.id.length > 0 &&
      entry.id.length <= 200 &&
      Array.isArray(entry.operations) &&
      entry.operations.length > 0 &&
      new Set(entry.operations).size === entry.operations.length &&
      entry.operations.every(
        (operation) =>
          typeof operation === "string" && operations.includes(operation),
      )
    );
  };
  if (
    !object(value) ||
    !fields(value, [
      "version",
      "source",
      "target",
      "release",
      "models",
      ...(Object.hasOwn(value, "processing") ? ["processing"] : []),
    ]) ||
    value.version !== 1 ||
    value.source !== provider ||
    value.target !== `plugin.ohmygame.${provider}.${provider}` ||
    !object(value.release) ||
    !fields(value.release, ["id", "version", "digest"]) ||
    value.release.id !== `ohmygame/${provider}` ||
    typeof value.release.version !== "string" ||
    !value.release.version.length ||
    typeof value.release.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.release.digest) ||
    !Array.isArray(value.models) ||
    !value.models.length ||
    !value.models.every((entry) => identity(entry, ["text", "image"])) ||
    new Set(value.models.map((entry) => entry.id)).size !==
      value.models.length ||
    (Object.hasOwn(value, "processing") &&
      (!identity(value.processing, ["remesh", "retexture", "animate"]) ||
        value.models.some(
          (entry) => entry.id === (value.processing as { id: string }).id,
        )))
  )
    throw invalid();
  // Historical release identity is evidence, not a fresh installation/permission check.
  // Do not compare it with today's pins: retiring an npm version cannot undo a commit.
  return value as unknown as ReferenceRecord;
}
