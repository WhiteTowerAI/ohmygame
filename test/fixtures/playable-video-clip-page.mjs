export function mount({ root }) {
  const video = root.querySelector("video");
  Object.defineProperty(video, "duration", { configurable: true, value: 12 });
  video.dispatchEvent(
    new root.ownerDocument.defaultView.Event("loadedmetadata"),
  );
  root.host.dataset.timeAtMount = String(video.currentTime);
  if (root.querySelector("[data-fail]"))
    throw new Error("Fixture mount failed");
}
