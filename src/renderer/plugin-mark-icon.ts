import { useEffect, useState } from "react";
import { MODELS_CHANGED_EVENT, readPluginAgentIcon, readPluginProviderIcon } from "./api.js";

// A plugin's model provider or agent can bring its own icon. Each is read once
// and kept as an object URL, as the model menu shows the same marks many
// times; a change to the models or agents reads them again.
const icons = new Map<string, Promise<string | null>>();
let listening = false;

/** Whether an id is a plugin's provider (`plugin.<publisher>.<name>.<id>`) or agent (`agent.<publisher>.<name>.<id>`). */
export function isPluginMarkId(id: string | undefined): id is string {
  return Boolean(id?.startsWith("plugin.") || id?.startsWith("agent."));
}

/** A plugin provider's or agent's icon as an object URL: undefined while it loads, null without one. */
export function usePluginIcon(id: string | undefined, revision = ""): string | null | undefined {
  const key = id ? `${id}\n${revision}` : undefined;
  const [url, setUrl] = useState<{ key: string; url: string | null }>();
  useEffect(() => {
    if (!key || !id) return;
    if (!listening) {
      listening = true;
      // Marks on screen keep the URL they have, so none is revoked; they're small.
      window.addEventListener(MODELS_CHANGED_EVENT, () => icons.clear());
    }
    let read = icons.get(key);
    if (!read) {
      read = (id.startsWith("agent.") ? readPluginAgentIcon(id) : readPluginProviderIcon(id)).then((blob) => URL.createObjectURL(blob), () => null);
      icons.set(key, read);
    }
    let live = true;
    void read.then((next) => { if (live) setUrl({ key, url: next }); });
    return () => { live = false; };
  }, [key]);
  return !key ? null : url?.key === key ? url.url : undefined;
}
