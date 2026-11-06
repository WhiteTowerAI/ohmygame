export const MODELS_CHANGED_EVENT = "ohmygame-models-changed";

// One channel per renderer so the sender doesn't receive its own broadcast.
let channel: BroadcastChannel | undefined;
let subscribers = 0;
function modelChannel() {
  if (window.BroadcastChannel) channel ??= new window.BroadcastChannel(MODELS_CHANGED_EVENT);
  return channel;
}
function closeUnusedChannel() {
  if (subscribers) return;
  channel?.close();
  channel = undefined;
}
export function notifyAgentModelsChanged(): void {
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
  modelChannel()?.postMessage(null);
  closeUnusedChannel();
}

/** Cloud quotas and CLI credentials can change outside this app. Check them while the settings page is visible. */
export function followProviderSettings(load: () => Promise<void>) {
  let timer: number | undefined;
  let active = true, running = false, dirty = false;
  const refresh = async () => {
    dirty = true;
    if (running) return;
    running = true;
    try {
      while (active && dirty && !document.hidden) {
        dirty = false;
        await load();
      }
    } finally { running = false; }
  };
  const visibility = () => {
    window.clearInterval(timer);
    if (!document.hidden) {
      timer = window.setInterval(refresh, 30_000);
      void refresh();
    }
  };
  subscribers++;
  modelChannel()?.addEventListener("message", refresh);
  window.addEventListener(MODELS_CHANGED_EVENT, refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    active = false;
    window.clearInterval(timer);
    channel?.removeEventListener("message", refresh);
    subscribers--;
    closeUnusedChannel();
    window.removeEventListener(MODELS_CHANGED_EVENT, refresh);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", visibility);
  };
}
