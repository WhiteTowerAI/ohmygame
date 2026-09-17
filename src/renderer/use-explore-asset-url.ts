import { useEffect, useState } from "react";
import { getExploreAssetContent } from "./api.js";

export function useExploreAssetUrl(assetId?: string): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    if (!assetId) {
      setState({});
      return;
    }
    let active = true;
    let objectUrl: string | undefined;
    setState({});
    void getExploreAssetContent(assetId).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ url: objectUrl });
    }).catch((cause) => {
      if (active) setState({ error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);

  return state;
}
