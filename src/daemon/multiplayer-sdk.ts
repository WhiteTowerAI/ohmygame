import { readFile } from "node:fs/promises";

/** Source development builds on demand; packaged apps carry these resources. */
let pending: Promise<Record<string, string>> | undefined;
export function multiplayerSdkResources(): Promise<Record<string, string>> {
  pending ??= import.meta.url.endsWith(".ts")
    ? import(new URL("../../packages/sdk/build.mjs", import.meta.url).href).then(
        ({ browserSdkResources }) => browserSdkResources(),
      )
    : readFile(
        new URL("../multiplayer-sdk/resources.json", import.meta.url),
        "utf8",
      ).then((text) => JSON.parse(text));
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
