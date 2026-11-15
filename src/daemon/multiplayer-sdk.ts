import { readFile } from "node:fs/promises";

/** The files setup writes to a game's src/ohmygame: the SDK, and helpers for built-in rules by adapterId. */
export interface MultiplayerSdkResources {
  sdk: Record<string, string>;
  games: Record<string, Record<string, string>>;
}

/** Source development builds on demand; packaged apps carry these resources. */
let pending: Promise<MultiplayerSdkResources> | undefined;
export function multiplayerSdkResources(): Promise<MultiplayerSdkResources> {
  pending ??= import.meta.url.endsWith(".ts")
    ? Promise.all([
        import(new URL("../../packages/sdk/build.mjs", import.meta.url).href).then(
          ({ browserSdkResources }) => browserSdkResources(),
        ),
        import(new URL("../../packages/games/build.mjs", import.meta.url).href).then(
          ({ builtInGameResources }) => builtInGameResources(),
        ),
      ]).then(([sdk, games]) => ({ sdk, games }))
    : readFile(
        new URL("../multiplayer-sdk/resources.json", import.meta.url),
        "utf8",
      ).then((text) => JSON.parse(text));
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
