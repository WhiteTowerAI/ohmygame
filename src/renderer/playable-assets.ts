import type { NodeGraph, PlayableAssetSource } from "../shared/playable-nodes.js";
import { getLibraryAsset, getWorkspaceAsset } from "./api.js";

/**
 * Loads every Asset the graph declares, keyed by Asset ID. A cache keyed by
 * source lets a preview reload after an edit without downloading files again.
 */
export async function loadPlayableAssets(
  projectId: string,
  graph: NodeGraph,
  cache?: Map<string, Blob>,
): Promise<Record<string, Blob>> {
  const assets = await mapConcurrent(Object.entries(graph.assets), 4, async ([id, asset]) => {
    const key = sourceKey(asset.source);
    const cached = cache?.get(key);
    if (cached) return [id, cached] as const;
    try {
      const blob = asset.source.kind === "library"
        ? await getLibraryAsset(asset.source.assetId)
        : await getWorkspaceAsset(projectId, asset.source.path);
      cache?.set(key, blob);
      return [id, blob] as const;
    } catch (cause) {
      throw new Error(`Could not load Asset "${id}": ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  });
  return Object.fromEntries(assets);
}

function sourceKey(source: PlayableAssetSource): string {
  return source.kind === "library" ? `library:${source.assetId}` : `workspace:${source.path}`;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await operation(values[index]!);
    }
  }));
  return results;
}
