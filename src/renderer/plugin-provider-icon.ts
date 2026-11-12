import { useEffect, useState } from "react";
import { MODELS_CHANGED_EVENT, readPluginProviderIcon } from "./api.js";

// A plugin's model provider can bring its own icon. Each is read once and kept
// as an object URL, as the model menu shows the same marks many times; a
// change to the plugins' providers reads them again.
const icons = new Map<string, Promise<string | null>>();
let listening = false;

/** Whether a provider id is one a plugin adds (`plugin.<publisher>.<name>.<id>`). */
export function isPluginProviderId(id: string | undefined): id is string {
  return Boolean(id?.startsWith("plugin."));
}

/** A plugin provider's icon as an object URL: undefined while it loads, null without one. */
export function usePluginProviderIcon(providerId: string | undefined, revision = ""): string | null | undefined {
  const key = providerId ? `${providerId}\n${revision}` : undefined;
  const [url, setUrl] = useState<{ key: string; url: string | null }>();
  useEffect(() => {
    if (!key || !providerId) return;
    if (!listening) {
      listening = true;
      // Marks on screen keep the URL they have, so none is revoked; they're small.
      window.addEventListener(MODELS_CHANGED_EVENT, () => icons.clear());
    }
    let read = icons.get(key);
    if (!read) {
      read = readPluginProviderIcon(providerId).then((blob) => URL.createObjectURL(blob), () => null);
      icons.set(key, read);
    }
    let live = true;
    void read.then((next) => { if (live) setUrl({ key, url: next }); });
    return () => { live = false; };
  }, [key]);
  return !key ? null : url?.key === key ? url.url : undefined;
}
