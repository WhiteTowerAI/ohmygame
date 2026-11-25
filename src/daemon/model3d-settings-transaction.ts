import { isDeepStrictEqual } from "node:util";
import type { CustomModel3DSettings } from "../shared/contracts.js";
import { normalizeModelUsages } from "../shared/custom-models.js";
import type { Native3DProviderId } from "../shared/model3d-presets.js";
import type {
  PluginMediaModels,
  PluginMediaProcessingModel,
} from "../shared/plugin-manifest.js";
import type { Model3DReferenceMigration } from "./media-model-migration.js";
import type { Model3DMigrationPackage } from "./model3d-migration-package.js";
import {
  model3DSettingsFiles,
  proposeModel3DSettings,
} from "./model3d-migration-settings.js";
import { createSettingsTransaction } from "./media-settings-transaction.js";
import type { Snapshot } from "./media-settings-snapshot.js";

interface ReferenceRecord extends Model3DReferenceMigration {
  version: 1;
  release: { id: string; version: string; digest: string };
  recovery?: NativeModel3DSettings;
}

export interface NativeModel3DSettings {
  models: { id: string; settings: CustomModel3DSettings }[];
  processing: { id: string; settings: CustomModel3DSettings };
}
export interface CommittedModel3DMigration {
  references: Model3DReferenceMigration;
  recovery: NativeModel3DSettings;
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
    sources: [`${provider}.json`],
    journal: `.${provider}-settings-transaction.json`,
    backup: `.${provider}-settings-committed-v1.json`,
    label: provider,
  });
  const { committedSettingsFile, ...operations } = transaction;
  const read = async (directory: string) => {
    const entry = await committedSettingsFile(
      directory,
      referenceFile(provider),
    );
    return entry ? parseReferences(entry.bytes, provider) : undefined;
  };
  const references = ({
    source,
    target,
    models,
    processing,
  }: ReferenceRecord): Model3DReferenceMigration => ({
    source,
    target,
    models,
    ...(processing ? { processing } : {}),
  });
  return {
    ...operations,
    async committedReferences(
      directory: string,
    ): Promise<Model3DReferenceMigration | undefined> {
      const record = await read(directory);
      return record && references(record);
    },
    async committedMigration(
      directory: string,
    ): Promise<CommittedModel3DMigration | undefined> {
      const record = await read(directory);
      if (!record) return undefined;
      // Earlier preparation records can still map references, but cannot reconstruct
      // original paid request defaults. Never fill them from today's presets.
      if (!record.recovery)
        throw new Error(
          "The committed 3D migration has no original recovery settings",
        );
      return { references: references(record), recovery: record.recovery };
    },
  };
}

/**
 * Caller supplies models from the exact reviewed package after verifying its bytes.
 * The same proposal owns settings and reference identities; neither may commit alone.
 */
export async function proposeModel3DTransaction(
  original: Snapshot,
  pin: Model3DMigrationPackage,
  media: {
    models: readonly PluginMediaModels["3d"][];
    processing?: PluginMediaProcessingModel;
  },
) {
  const { provider } = pin;
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
  const record: ReferenceRecord = {
    version: 1,
    source: provider,
    target: `plugin.ohmygame.${provider}.${provider}`,
    release: { id: pin.id, version: pin.version, digest: pin.digest },
    models: plan.references!,
    recovery: plan.recovery!,
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
      ...(Object.hasOwn(value, "recovery") ? ["recovery"] : []),
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
  if (Object.hasOwn(value, "recovery")) {
    const recovery = value.recovery;
    const model = (entry: unknown) => {
      if (
        !object(entry) ||
        !fields(entry, ["id", "settings"]) ||
        typeof entry.id !== "string" ||
        !entry.id.length ||
        entry.id.length > 200 ||
        /[\s\x00-\x1f]/.test(entry.id) ||
        !object(entry.settings)
      )
        return false;
      try {
        const settings = normalizeModelUsages({ "3d": entry.settings })?.["3d"];
        return (
          settings?.protocol === provider &&
          !settings.baseUrl &&
          isDeepStrictEqual(settings, entry.settings)
        );
      } catch {
        return false;
      }
    };
    if (
      !object(recovery) ||
      !fields(recovery, ["models", "processing"]) ||
      !Array.isArray(recovery.models) ||
      recovery.models.length !== value.models.length ||
      !recovery.models.every(model) ||
      new Set(recovery.models.map((entry) => entry.id)).size !==
        recovery.models.length ||
      !value.models.every((entry) =>
        (recovery.models as { id: string }[]).some(
          (original) => original.id === entry.id,
        ),
      ) ||
      !model(recovery.processing) ||
      (recovery.processing as { id: string }).id !== "connection"
    )
      throw invalid();
  }
  // Historical release identity is evidence, not a fresh installation/permission check.
  // Do not compare it with today's pins: retiring an npm version cannot undo a commit.
  return value as unknown as ReferenceRecord;
}
