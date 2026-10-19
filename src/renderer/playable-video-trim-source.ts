import type { NodeGraph, PlayableNode } from "../shared/playable-nodes.js";
import {
  playableBackdropDetails,
  type PlayableBackdropDetails,
} from "../shared/playable-backdrop.js";
import { getLibraryAsset, getWorkspaceAsset, getWorkspaceFile } from "./api.js";

export interface PlayableVideoTrimSource {
  details: PlayableBackdropDetails;
  source: string;
  blob: Blob;
}

/** Web previews do not preload Blob assets; read only this Scene's authored background. */
export async function readPlayableVideoTrimSource(
  projectId: string,
  node: PlayableNode,
  graph: NodeGraph,
): Promise<PlayableVideoTrimSource | undefined> {
  const file = await getWorkspaceFile(projectId, node.source.html);
  if (file.truncated || file.content === undefined) return undefined;
  const details = playableBackdropDetails(file.content);
  if (
    !details ||
    details.type !== "video" ||
    !node.assets.includes(details.assetId)
  )
    return undefined;
  const asset = graph.assets[details.assetId];
  if (!asset || asset.type !== "video") return undefined;
  const blob =
    asset.source.kind === "library"
      ? await getLibraryAsset(asset.source.assetId)
      : await getWorkspaceAsset(projectId, asset.source.path);
  return { details, source: JSON.stringify(asset), blob };
}
