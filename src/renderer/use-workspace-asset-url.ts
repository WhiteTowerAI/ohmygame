import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CanvasAssetCatalogEntry, UnavailableCanvasAsset } from "../shared/canvas-assets.js";
import { getWorkspaceAsset } from "./api.js";
import { t } from "./i18n.js";
import { useImagePreview } from "./image-preview.js";
import { acquireModelFile } from "./model-file.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";

export interface LocalCanvasAsset { projectId: string; path: string; name: string; revision: number; size?: number; error?: string }
export function canvasAssetSources(projectId: string, assets: readonly CanvasAssetCatalogEntry[], unavailable: readonly UnavailableCanvasAsset[] = []): ReadonlyMap<string, LocalCanvasAsset> {
  return new Map([
    ...assets.map((asset): [string, LocalCanvasAsset] => [asset.id, { projectId, path: asset.path, name: asset.name, revision: Date.parse(asset.createdAt), size: asset.size }]),
    ...unavailable.map((asset): [string, LocalCanvasAsset] => [asset.id, { projectId, path: asset.path, name: asset.name, revision: 0, error: asset.status === "missing" ? t("assets.fileMissing", { path: asset.path }) : t("assets.fileUnavailable", { path: asset.path }) }]),
  ]);
}
const CanvasAssets = createContext<{ byId: ReadonlyMap<string, LocalCanvasAsset>; byPath: ReadonlyMap<string, LocalCanvasAsset> }>({ byId: new Map(), byPath: new Map() });
export function useCanvasAssetSources(): ReadonlyMap<string, LocalCanvasAsset> {
  return useContext(CanvasAssets).byId;
}
export function CanvasAssetProvider({ assets, children }: { assets: ReadonlyMap<string, LocalCanvasAsset>; children: ReactNode }) {
  const value = useMemo(() => ({ byId: assets, byPath: new Map([...assets.values()].map((asset) => [JSON.stringify([asset.projectId, asset.path]), asset])) }), [assets]);
  return createElement(CanvasAssets.Provider, { value }, children);
}

/** A project file, or the one a canvas asset id names; an id the canvas doesn't know has no file. */
export function useWorkspaceAssetSource(projectId: string | undefined, filePath: string, assetId?: string) {
  const assets = useContext(CanvasAssets);
  const local = assetId ? assets.byId.get(assetId) : assets.byPath.get(JSON.stringify([projectId, filePath]));
  return local
    ? { projectId: local.projectId, filePath: local.path, local }
    : { projectId: assetId ? undefined : projectId, filePath, local };
}

export function useWorkspaceImagePreview(project: string | undefined, path: string, revision: string | number = 0, assetId?: string) {
  const { projectId, filePath, local } = useWorkspaceAssetSource(project, path, assetId);
  const runtime = useReadyRuntimeGeneration();
  const key = projectId ? JSON.stringify([projectId, filePath, local?.error]) : undefined;
  const load = useCallback((signal: AbortSignal) => getWorkspaceAsset(projectId!, filePath, signal), [projectId, filePath]);
  const preview = useImagePreview(key, JSON.stringify([revision, local?.revision, runtime]), load);
  return { ...preview, error: preview.error ?? (preview.url ? undefined : local?.error) };
}

export function useWorkspaceAssetUrl(
  project: string | undefined,
  path: string,
  fileRevision = 0,
  assetId?: string,
  /** False waits to download the file, such as until its canvas node is on screen. */
  enabled = true,
  shareModel = false,
): { url?: string; error?: string; loading: boolean; size?: number; retry(): void } {
  const { projectId, filePath, local } = useWorkspaceAssetSource(project, path, assetId);
  const revision = local?.revision ?? fileRevision;
  const resourceKey = JSON.stringify([projectId, filePath, revision, local?.error]);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [state, setState] = useState<{ key?: string; url?: string; error?: string; loading: boolean }>({ loading: false });

  useEffect(() => {
    if (!enabled) return;
    if (!projectId) {
      setState({ key: resourceKey, loading: false });
      return;
    }
    let disposed = false;
    let objectUrl: string | undefined;
    setState({ key: resourceKey, loading: true, error: local?.error });
    const model = shareModel ? acquireModelFile(projectId, filePath, revision) : undefined;
    const read = model ? model.result : getWorkspaceAsset(projectId, filePath);
    void read.then((blob) => {
      if (disposed) return;
      const url = typeof blob === "string" ? blob : (objectUrl = URL.createObjectURL(blob));
      setState({ key: resourceKey, url, loading: false });
    }).catch((cause) => {
      if (!disposed) setState({ key: resourceKey, error: local?.error ?? errorMessage(cause), loading: false });
    });
    return () => {
      disposed = true;
      model?.release();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, filePath, revision, local?.error, resourceKey, attempt, enabled, shareModel]);

  const current = state.key === resourceKey ? state : { error: local?.error, loading: enabled && !!projectId };
  return { ...current, size: local?.size, retry };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
