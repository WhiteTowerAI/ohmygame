import { useEffect, useState } from "react";
import { getLibraryAsset, getWorkspaceAsset } from "./api.js";

export function useWorkspaceAssetUrl(
  projectId: string | undefined,
  filePath: string,
  revision = 0,
  libraryAssetId?: string,
): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    if (!projectId && !libraryAssetId) {
      setState({});
      return;
    }
    let disposed = false;
    let objectUrl: string | undefined;
    setState({});
    void (libraryAssetId ? getLibraryAsset(libraryAssetId) : getWorkspaceAsset(projectId!, filePath)).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ url: objectUrl });
    }).catch((cause) => {
      if (!disposed) setState({ error: errorMessage(cause) });
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, filePath, revision, libraryAssetId]);

  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
