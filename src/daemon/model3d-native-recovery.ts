import path from "node:path";
import type { Model3DModelRef, Model3DOperation } from "../shared/contracts.js";
import { model3DModel } from "../shared/custom-models.js";
import { NATIVE_3D_PROVIDER_NAMES } from "../shared/model3d-presets.js";
import type { CommittedModel3DMigration } from "./model3d-settings-transaction.js";
import { model3DJournal } from "./model3d-journal.js";
import { MeshyProvider } from "./meshy-provider.js";
import { TripoProvider } from "./tripo-provider.js";
import { Hyper3DProvider } from "./hyper3d-provider.js";
import {
  Model3DGenerationError,
  Model3DRequestNotSent,
  type Model3DGenerator,
} from "./model3d.js";

const providers = {
  meshy: MeshyProvider,
  tripo: TripoProvider,
  hyper3d: Hyper3DProvider,
};

/** Recovery has no catalog: only a saved native task can pass its first-stage gate. */
export class NativeModel3DRecovery {
  readonly #migrations: readonly CommittedModel3DMigration[];
  constructor(
    private readonly directory: string,
    migrations: readonly CommittedModel3DMigration[],
    /** Must verify current installation, grants, enablement and key; never read retained native keys. */
    private readonly authorize: (
      migration: CommittedModel3DMigration,
      url?: URL,
    ) => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {
    this.#migrations = structuredClone(migrations);
  }

  async forTask(
    ref: Model3DModelRef | undefined,
    operation: Model3DOperation,
    recoveryId: string,
  ): Promise<Model3DGenerator | undefined> {
    const source =
      ref?.provider ?? (operation === "animate" ? "meshy" : undefined);
    const migration = this.#migrations.find(
      ({ references }) => references.source === source,
    );
    if (!migration) return undefined;
    const { references, recovery } = migration;
    const select = (
      model: Model3DModelRef | undefined,
      action: Model3DOperation,
    ) => {
      if (model && model.provider !== references.source) return undefined;
      const original =
        action === "image" || action === "text"
          ? recovery.models.find(({ id }) => id === model?.id)
          : recovery.processing;
      if (!original) return undefined;
      const selected = model3DModel(
        references.source,
        NATIVE_3D_PROVIDER_NAMES[references.source],
        { ...original, name: original.id },
      );
      return selected.operations?.includes(action)
        ? { selected, settings: original.settings }
        : undefined;
    };
    if (!select(ref, operation))
      throw new Model3DGenerationError(
        "The original 3D model settings are unavailable for recovery",
        409,
      );
    const key = await this.authorize(migration);
    if (!key)
      throw new Model3DGenerationError(
        "Enable the migrated 3D plugin and configure its original API key to resume this task",
        409,
      );
    const request: typeof fetch = async (input, init) => {
      try {
        const url =
          input instanceof URL
            ? input
            : new URL(typeof input === "string" ? input : input.url);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Model3DGenerationError(
            "The native 3D recovery address must use HTTPS without credentials",
            409,
          );
        init?.signal?.throwIfAborted();
        if ((await this.authorize(migration, url)) !== key)
          throw new Model3DGenerationError(
            "The 3D plugin connection changed during recovery",
            409,
          );
        init?.signal?.throwIfAborted();
      } catch (cause) {
        // Only failures before dispatch prove that no paid request was submitted.
        throw new Model3DRequestNotSent(
          cause instanceof Model3DGenerationError
            ? cause.message
            : "Native 3D recovery stopped before sending a request",
          409,
        );
      }
      // A redirect must not bypass the current plugin's approved hosts.
      return this.request(input, { ...init, redirect: "error" });
    };
    const Provider = providers[references.source];
    const native = new Provider(() => key, request);
    const execution = await model3DJournal(
      path.join(this.directory, "tools/model3d-tasks"),
      recoveryId,
      { requireExistingStage: true },
    );
    return {
      resolveOperationModel: async (model, action) =>
        select(model, action)?.selected,
      resolveModel: async (model) => select(model, "image")?.selected,
      generate: async (input, signal) => {
        const original = select(input.model, input.operation ?? "image");
        if (!original)
          throw new Model3DGenerationError(
            "The original 3D model settings are unavailable for recovery",
            409,
          );
        return native.generate(
          { ...input, execution },
          signal,
          original.settings,
        );
      },
      ...(native instanceof Hyper3DProvider
        ? {}
        : ({
            animate: async (input, signal) =>
              native.animate({ ...input, execution }, signal),
          } satisfies Pick<Model3DGenerator, "animate">)),
    };
  }
}
